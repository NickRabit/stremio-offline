import nodeDns, { type LookupOptions } from "node:dns";
import net from "node:net";
import { Agent, fetch as undiciFetch } from "undici";
import {
  MediaServerError,
  MEDIA_SERVER_LIMITS,
  validateArtworkTag,
  validateMediaServerToken,
  type MediaServerKind,
} from "./media-server-types.js";
import { noteProviderCall } from "./provider-stats.js";

/** Requests the metadata transport is allowed to make, with the exact argument fields each
 *  one accepts. Anything else -- a raw path, a header, a stream or artwork URL -- is refused. */
export interface MediaServerOperationArgs {
  info: Record<string, never>;
  login: { username: string; password: string };
  user: { userId: string };
  views: { userId: string };
  items: { userId: string; parentId: string; includeItemTypes: string; startIndex?: number; limit?: number; searchTerm?: string };
  directory: { userId: string; parentId: string; includeItemTypes: string; recursive: boolean; sortBy: string; sortOrder: string; startIndex?: number; limit?: number; searchTerm?: string; parentIndexNumber?: number; enableTotalRecordCount?: boolean };
  match: { userId: string; parentId: string; provider: MediaServerKind; providerName: "imdb" | "tmdb" | "tvdb"; providerId: string; includeItemTypes: "Movie" | "Series"; searchTerm?: string; limit?: number };
  detail: { userId: string; itemId: string };
  ancestors: { itemId: string; userId: string };
  versions: { itemId: string; userId: string };
}
export type MediaServerOperationName = keyof MediaServerOperationArgs;

export interface MediaServerAddressPolicy {
  allowLan: boolean;
  allowLoopback: boolean;
}

export interface MediaServerTransport {
  requestJson<O extends MediaServerOperationName>(
    operation: O,
    args: MediaServerOperationArgs[O],
    token?: string,
    signal?: AbortSignal,
  ): Promise<unknown>;
  requestOriginal(args: OriginalMediaRequest, token: string, signal?: AbortSignal): Promise<Response>;
  requestArtwork(args: ArtworkRequest, token: string, signal?: AbortSignal): Promise<Response>;
  requestAsset(request: MediaServerAssetRequest, token: string, signal?: AbortSignal): Promise<MediaServerAsset>;
  close(): Promise<void>;
}

/** The only artwork request the transport can make: a fixed image role for one opaque item id, at
 *  most one validated tag and at most one of the two fixed size variants. A URL, query, header,
 *  method, arbitrary dimension or output format is never caller text. */
export interface ArtworkRequest {
  itemId: string;
  imageType: "Primary" | "Backdrop" | "Thumb";
  tag?: string;
  /** One of the two fixed widths: the listing tile or the full detail; never an arbitrary
   *  dimension. Absent keeps whatever a role was fetched at before the variants existed. */
  size?: "tile" | "detail";
}

/** The only original-media request the transport can make: a fixed static stream path built from
 *  two opaque ids, a GET or HEAD, and at most one HTTP byte range. No URL, path, arbitrary header
 *  or body is accepted. */
export interface OriginalMediaRequest {
  itemId: string;
  mediaSourceId: string;
  method: "GET" | "HEAD";
  range?: string;
}

/** The only binary assets the transport can fetch: fixed official artwork and one subtitle track.
 *  The caller names an item and a fixed image role or subtitle index; a URL, query, header,
 *  method or output format is never part of the request. */
export type MediaServerAssetRequest =
  | { kind: "artwork"; itemId: string; imageType: "Primary" | "Backdrop" | "Thumb" }
  | { kind: "subtitle"; itemId: string; mediaSourceId: string; index: number };

export interface MediaServerAsset {
  bytes: Uint8Array;
  contentType: string;
}

export interface MediaServerTransportConfig extends MediaServerAddressPolicy {
  baseUrl: string;
  deviceId?: string;
}

export interface LookupAddress {
  address: string;
  family: number;
}
export type LookupAll = (hostname: string, options: { all: true; family?: number }) => Promise<LookupAddress[]>;
export type MediaServerFetch = (url: string, init: RequestInit) => Promise<Response>;

export interface MediaServerTransportSeams {
  lookupAll?: LookupAll;
  fetch?: MediaServerFetch;
  /** Extra dispatcher connect options. Tests pin `family` to prove a mixed-family answer set
   *  is refused before family filtering; the address guard is always applied. */
  connectOptions?: Record<string, unknown>;
  /** Shorter original-stream deadlines for tests: a positive integer no greater than the
   *  production default. Anything else is refused when the transport is built. */
  originalHeaderMs?: number;
  originalIdleMs?: number;
  originalLifetimeMs?: number;
  /** Shorter artwork deadlines for tests, bounded the same way as the original-stream seams. */
  imageHeaderMs?: number;
  imageIdleMs?: number;
  imageLifetimeMs?: number;
}

const MAX_CONCURRENCY = 4;
const DEADLINE_MS = 10_000;
const MAX_RETRY_AFTER_MS = 300_000;
/** A 429 without a usable Retry-After still parks the transport for this long. */
const COOLDOWN_DEFAULT_MS = 30_000;
const ORIGINAL_MAX_CONCURRENCY = 8;
const ORIGINAL_HEADER_MS = 10_000;
const ORIGINAL_IDLE_MS = 30_000;
const ORIGINAL_LIFETIME_MS = 6 * 60 * 60 * 1000;
const ORIGINAL_RANGE_MAX = 128;
const ORIGINAL_HEADER_TYPE_MAX = 256;
const ORIGINAL_HEADER_ETAG_MAX = 512;
const ORIGINAL_HEADER_DATE_MAX = 128;
const IMAGE_MAX_CONCURRENCY = 32;
const IMAGE_HEADER_MS = 10_000;
const IMAGE_IDLE_MS = 30_000;
const IMAGE_LIFETIME_MS = 5 * 60 * 1000;
const IMAGE_MAX_BYTES = 5 * 1024 * 1024;
/** Image DNS runs in its own bounded counter, so a burst of posters never starves the four
 *  metadata lookup slots (and a stalled metadata lookup never starves the image pool). */
const IMAGE_DNS_MAX = IMAGE_MAX_CONCURRENCY;

/** Separate streaming pool and deadlines for original-media reads. Metadata keeps its own
 *  4-request pool and single 10s deadline; the two never share capacity. */
export const MEDIA_SERVER_ORIGINAL_LIMITS = Object.freeze({
  concurrency: ORIGINAL_MAX_CONCURRENCY,
  headerMs: ORIGINAL_HEADER_MS,
  idleMs: ORIGINAL_IDLE_MS,
  lifetimeMs: ORIGINAL_LIFETIME_MS,
  rangeMax: ORIGINAL_RANGE_MAX,
});

/** A separate streaming pool and deadlines for artwork: a burst of posters reads concurrently
 *  without borrowing a metadata slot, under a fixed per-image cap. */
export const MEDIA_SERVER_IMAGE_LIMITS = Object.freeze({
  concurrency: IMAGE_MAX_CONCURRENCY,
  headerMs: IMAGE_HEADER_MS,
  idleMs: IMAGE_IDLE_MS,
  lifetimeMs: IMAGE_LIFETIME_MS,
  maxBytes: IMAGE_MAX_BYTES,
});
const CLIENT = "Stremio Offline";
const DEVICE = "Server";
const DEVICE_ID = "stremio-offline-server";
const CLIENT_VERSION = "1.0.0";
const ITEM_TYPES = new Set(["Movie", "Series", "Season", "Episode", "MusicVideo"]);
/** The directory listing admits Folder alongside the media types; the recursive `items`
 *  operation above never does, so the old snapshot contract is unchanged. */
const DIRECTORY_ITEM_TYPES = new Set(["Folder", "Movie", "Series", "Season", "Episode", "MusicVideo"]);
const DIRECTORY_SORT_BY = new Set(["SortName", "DateCreated", "Size", "ParentIndexNumber,IndexNumber,SortName"]);
const DIRECTORY_SORT_ORDER = new Set(["Ascending", "Descending"]);

const invalid = (message: string): MediaServerError => new MediaServerError("invalid-input", message);
const lookupFailure = (): MediaServerError => new MediaServerError("unsafe-address", "The media-server name did not resolve.");

const CONTROL = /[\u0000-\u001f\u007f]/;
const RAW_ILLEGAL = /[\s\u0000-\u001f\u007f\\]/;

/** One path segment, decoded once, so an encoded separator, dot segment, control byte or
 *  double escape is refused before it reaches a URL. */
function decodeSegment(raw: string): string {
  let decoded: string;
  try { decoded = decodeURIComponent(raw); }
  catch { throw invalid("The media-server URL has a malformed escape."); }
  if (decoded.includes("%")) throw invalid("The media-server URL encodes an escape twice.");
  if (/[\/\\]/.test(decoded) || CONTROL.test(decoded)) throw invalid("The media-server URL path is not allowed.");
  if (decoded === "." || decoded === "..") throw invalid("The media-server URL path is not allowed.");
  return decoded;
}

/** Normalize a connection URL to `origin + optional base path`, with no credentials, query,
 *  fragment, dot segment, empty interior segment or encoded separator. Exactly one final slash
 *  is allowed and stripped; anything more is refused. */
export function normalizeMediaServerUrl(raw: string): string {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > MEDIA_SERVER_LIMITS.url) {
    throw invalid("The media-server URL is missing or too long.");
  }
  if (RAW_ILLEGAL.test(raw)) throw invalid("The media-server URL contains a forbidden character.");
  const scheme = /^(https?):\/\//i.exec(raw);
  if (!scheme) throw invalid("Only an absolute HTTP(S) media-server URL is accepted.");
  const lowerScheme = scheme[1].toLowerCase();
  const afterScheme = raw.slice(scheme[0].length);
  const slash = afterScheme.indexOf("/");
  const authority = slash === -1 ? afterScheme : afterScheme.slice(0, slash);
  const rawPath = slash === -1 ? "" : afterScheme.slice(slash);
  if (authority.length === 0 || authority.includes("@")) throw invalid("The media-server URL has an invalid authority.");
  if (/[?#]/.test(rawPath)) throw invalid("The media-server URL must not carry a query or fragment.");

  const parts = rawPath.split("/");
  if (parts.length > 1 && parts[parts.length - 1] === "") parts.pop();
  const segments = parts.slice(1);
  for (const segment of segments) {
    if (segment === "") throw invalid("The media-server URL has an empty path segment.");
  }
  const path = segments.length ? `/${segments.map((segment) => encodeURIComponent(decodeSegment(segment))).join("/")}` : "";

  let url: URL;
  try { url = new URL(`${lowerScheme}://${authority}${path}`); }
  catch { throw invalid("The media-server URL is malformed."); }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw invalid("Only HTTP(S) media-server URLs are accepted.");
  if (url.username || url.password) throw invalid("The media-server URL must not contain credentials.");
  if (url.search || url.hash) throw invalid("The media-server URL must not carry a query or fragment.");
  if (url.hostname.includes("%")) throw invalid("The media-server URL must not carry a zone identifier.");
  const normalized = `${url.origin}${path}`;
  if (normalized.length > MEDIA_SERVER_LIMITS.url) throw invalid("The normalized media-server URL is too long.");
  return normalized;
}

const v4Refusal = (address: string, policy: MediaServerAddressPolicy): string | undefined => {
  const [a, b, c, d] = address.split(".").map(Number);
  if (a === 127) return policy.allowLoopback ? undefined : "loopback is not enabled";
  if (a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)) {
    return policy.allowLan ? undefined : "the LAN is not enabled";
  }
  if (a === 0) return "an unspecified range";
  if (a === 169 && b === 254) return "a link-local range";
  if (a === 100 && b >= 64 && b <= 127) return "a CGNAT range";
  if (a === 192 && b === 0 && c === 0) return "a reserved range";
  if (a === 192 && b === 0 && c === 2) return "a documentation range";
  if (a === 192 && b === 88 && c === 99) return "a reserved range";
  if (a === 198 && (b === 18 || b === 19)) return "a benchmark range";
  if (a === 198 && b === 51 && c === 100) return "a documentation range";
  if (a === 203 && b === 0 && c === 113) return "a documentation range";
  if (a === 168 && b === 63 && c === 129 && d === 16) return "a platform range";
  if (a >= 224) return "a multicast or reserved range";
  return undefined;
};

const parseIPv6 = (input: string): Uint8Array | undefined => {
  let text = input;
  let embedded: number[] | undefined;
  if (text.includes(".")) {
    const lastColon = text.lastIndexOf(":");
    const tail = text.slice(lastColon + 1).split(".").map(Number);
    if (tail.length !== 4 || tail.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return undefined;
    embedded = tail;
    text = `${text.slice(0, lastColon + 1)}0:0`;
  }
  const halves = text.split("::");
  if (halves.length > 2) return undefined;
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 2 ? (halves[1] ? halves[1].split(":") : []) : undefined;
  const groups = tail === undefined ? head : [...head, ...Array(Math.max(0, 8 - head.length - tail.length)).fill("0"), ...tail];
  if (groups.length !== 8) return undefined;
  const bytes = new Uint8Array(16);
  for (let index = 0; index < 8; index += 1) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(groups[index])) return undefined;
    const value = parseInt(groups[index], 16);
    bytes[index * 2] = value >> 8;
    bytes[index * 2 + 1] = value & 0xff;
  }
  if (embedded) bytes.set(embedded, 12);
  return bytes;
};

const v6Refusal = (address: string, policy: MediaServerAddressPolicy): string | undefined => {
  const bytes = parseIPv6(address);
  if (!bytes) return "not a literal address";
  const firstTenZero = bytes.subarray(0, 10).every((value) => value === 0);
  if (firstTenZero && bytes[10] === 0xff && bytes[11] === 0xff) {
    return v4Refusal(`${bytes[12]}.${bytes[13]}.${bytes[14]}.${bytes[15]}`, policy);
  }
  if (bytes.every((value) => value === 0)) return "an unspecified address";
  if (bytes.subarray(0, 15).every((value) => value === 0) && bytes[15] === 1) {
    return policy.allowLoopback ? undefined : "loopback is not enabled";
  }
  if (bytes[0] === 0xfe && (bytes[1] & 0xc0) === 0x80) return "a link-local range";
  if (bytes[0] === 0xff) return "a multicast range";
  if ((bytes[0] & 0xfe) === 0xfc) return policy.allowLan ? undefined : "the LAN is not enabled";
  if ((bytes[0] & 0xe0) === 0x20) {
    if (bytes[0] === 0x20 && bytes[1] === 0x01 && (bytes[2] & 0xfe) === 0x00) return "a special-purpose range";
    if (bytes[0] === 0x20 && bytes[1] === 0x01 && bytes[2] === 0x0d && bytes[3] === 0xb8) return "a documentation range";
    if (bytes[0] === 0x20 && bytes[1] === 0x02) return "a transition range";
    if (bytes[0] === 0x3f && bytes[1] === 0xff && (bytes[2] & 0xf0) === 0) return "a documentation range";
    return undefined;
  }
  return "a special-purpose range";
};

/** Why a literal address may not be reached under this policy, or undefined when it may. A
 *  hostname is not a literal address: callers resolve first and check every answer. */
function addressRefusal(address: string, policy: MediaServerAddressPolicy): string | undefined {
  if (typeof address !== "string" || address.includes("%")) return "a zone identifier";
  const bare = address.replace(/^\[|\]$/g, "");
  if (net.isIPv4(bare)) return v4Refusal(bare, policy);
  if (net.isIPv6(bare)) return v6Refusal(bare, policy);
  return "not a literal address";
}

const checkPolicy = (policy: MediaServerAddressPolicy): MediaServerAddressPolicy => {
  if (typeof policy !== "object" || policy === null
    || typeof policy.allowLan !== "boolean" || typeof policy.allowLoopback !== "boolean") {
    throw invalid("The media-server address policy is malformed.");
  }
  return policy;
};

export function assertMediaServerAddress(address: string, policy: MediaServerAddressPolicy): void {
  checkPolicy(policy);
  const reason = addressRefusal(address, policy);
  if (reason) throw new MediaServerError("unsafe-address", `The media-server address is not allowed: ${reason}.`);
}

/** Every DNS answer is shape-checked, must be a literal address whose family matches the one
 *  reported, and is policy-checked *before* any family filtering. Filtering first would let a
 *  blocked answer of the other family slip through. */
function checkedAnswers(answers: unknown, policy: MediaServerAddressPolicy): LookupAddress[] {
  if (!Array.isArray(answers) || answers.length === 0) throw lookupFailure();
  const checked: LookupAddress[] = [];
  for (const answer of answers) {
    const address = (answer as { address?: unknown } | null)?.address;
    const family = (answer as { family?: unknown } | null)?.family;
    if (typeof address !== "string") throw lookupFailure();
    const version = net.isIP(address);
    if (version === 0 || family !== version) throw lookupFailure();
    assertMediaServerAddress(address, policy);
    checked.push({ address, family: version });
  }
  return checked;
}

const systemLookupAll: LookupAll = (hostname, options) =>
  new Promise((resolve, reject) => {
    nodeDns.lookup(hostname, { ...options, all: true }, (error, addresses) => {
      if (error) reject(error);
      else resolve((Array.isArray(addresses) ? addresses : []) as LookupAddress[]);
    });
  });

const abortError = (timedOut: boolean): MediaServerError =>
  timedOut
    ? new MediaServerError("timeout", "The media server did not answer in time.")
    : new MediaServerError("cancelled", "The media-server request was cancelled.");

/** Resolve a promise but give up the moment the deadline controller aborts. The underlying work
 *  -- an uncancellable lookup, say -- may still finish; its result is ignored. */
async function guard<T>(work: Promise<T>, signal: AbortSignal, timedOut: () => boolean): Promise<T> {
  if (signal.aborted) {
    void work.catch(() => undefined);
    throw abortError(timedOut());
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortError(timedOut()));
    signal.addEventListener("abort", onAbort, { once: true });
    work.then(
      (value) => { signal.removeEventListener("abort", onAbort); resolve(value); },
      (error) => { signal.removeEventListener("abort", onAbort); reject(error); },
    );
  });
}

function parseRetryAfter(header: string | null): number | undefined {
  if (!header) return undefined;
  const seconds = Number(header.trim());
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(MAX_RETRY_AFTER_MS, Math.round(seconds * 1000));
  const date = Date.parse(header);
  if (!Number.isNaN(date)) return Math.min(MAX_RETRY_AFTER_MS, Math.max(0, date - Date.now()));
  return undefined;
}

const statusError = (status: number, headers: Headers): MediaServerError => {
  if (status === 401) return new MediaServerError("authentication-required", "The media server refused the credentials.", status);
  if (status === 403) return new MediaServerError("forbidden", "The media server denied the request.", status);
  if (status === 404) return new MediaServerError("not-found", "The media server has no such item.", status);
  if (status === 429) {
    return new MediaServerError("rate-limited", "The media server is rate limiting requests.", status, parseRetryAfter(headers.get("retry-after")));
  }
  if (status >= 500) return new MediaServerError("unavailable", "The media server is unavailable.", status);
  return new MediaServerError("unavailable", "The media server refused the request.", status);
};

const invalidResponse = (message: string): MediaServerError => new MediaServerError("invalid-response", message);

/** A copied header must be short, non-empty and printable ASCII: it can never carry a control
 *  character, a folded value or an unbounded remote string. */
const PRINTABLE_HEADER = /^[\x20-\x7e]+$/;
const boundedHeader = (value: string | null, max: number): string | undefined =>
  value !== null && value.length > 0 && value.length <= max && PRINTABLE_HEADER.test(value) ? value : undefined;

const normalizedAcceptRanges = (value: string | null): "bytes" | "none" | undefined => {
  if (value === null) return undefined;
  const lower = value.trim().toLowerCase();
  return lower === "bytes" || lower === "none" ? lower : undefined;
};

/** A present Content-Length must be a canonical, safe, non-negative integer. */
function contentLengthValue(value: string | null): number | undefined {
  if (value === null) return undefined;
  if (!CANONICAL_DECIMAL.test(value)) throw invalidResponse("The media server sent an invalid length.");
  const length = Number(value);
  if (!Number.isSafeInteger(length)) throw invalidResponse("The media server sent an invalid length.");
  return length;
}

/** A 206 carries `bytes N-M/T` with `T` an integer greater than `M`; `*` is not a valid total. */
function satisfiedContentRange(value: string | null): { start: number; end: number; total: number } {
  const match = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(value ?? "");
  if (!match) throw invalidResponse("The media server sent an invalid content range.");
  const start = Number(match[1]);
  const end = Number(match[2]);
  const total = Number(match[3]);
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || !Number.isSafeInteger(total) || end < start || total <= end) {
    throw invalidResponse("The media server sent an invalid content range.");
  }
  return { start, end, total };
}

/** A 416 unsatisfied range carries only the total size; the byte span is always a star. */
function unsatisfiedContentRange(value: string | null): number {
  const match = /^bytes \*\/(\d+)$/.exec(value ?? "");
  if (!match) throw invalidResponse("The media server sent an invalid content range.");
  const total = Number(match[1]);
  if (!Number.isSafeInteger(total)) throw invalidResponse("The media server sent an invalid content range.");
  return total;
}

/** Build the only headers that leave the transport: validated length, range, accept-ranges and
 *  bounded content-type/etag/last-modified. Location, cookies, auth, remote error payloads, the
 *  server name, the upstream URL/status text and every other header are dropped. */
function sanitizedMediaHeaders(status: number, upstream: Headers): Headers {
  const out = new Headers();
  const length = contentLengthValue(upstream.get("content-length"));
  if (status === 206) {
    const range = satisfiedContentRange(upstream.get("content-range"));
    if (length !== undefined && length !== range.end - range.start + 1) {
      throw invalidResponse("The media server sent an inconsistent length.");
    }
    out.set("content-range", `bytes ${range.start}-${range.end}/${range.total}`);
  }
  if (length !== undefined) out.set("content-length", String(length));
  const acceptRanges = normalizedAcceptRanges(upstream.get("accept-ranges"));
  if (acceptRanges) out.set("accept-ranges", acceptRanges);
  out.set("content-type", boundedHeader(upstream.get("content-type"), ORIGINAL_HEADER_TYPE_MAX) ?? "application/octet-stream");
  const etag = boundedHeader(upstream.get("etag"), ORIGINAL_HEADER_ETAG_MAX);
  if (etag) out.set("etag", etag);
  const lastModified = boundedHeader(upstream.get("last-modified"), ORIGINAL_HEADER_DATE_MAX);
  if (lastModified) out.set("last-modified", lastModified);
  return out;
}

/** The id fields that become URL path segments. They may be opaque punctuation but never an
 *  empty, dot, separator, escape, control or query-bearing string. */
function pathSegment(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > MEDIA_SERVER_LIMITS.upstreamId) {
    throw invalid(`The media-server request field ${field} is missing or too long.`);
  }
  if (/[\/\\?#%]/.test(value) || CONTROL.test(value) || value === "." || value === "..") {
    throw invalid(`The media-server request field ${field} is not a valid path segment.`);
  }
  return value;
}

const boundedIndex = (value: unknown, field: string, max: number): number | undefined => {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > max) {
    throw invalid(`The media-server request field ${field} is out of range.`);
  }
  return value;
};

/** A page limit is always explicit: an omitted one becomes a bounded default, and an upstream
 *  `0` (which many servers treat as unlimited) is refused rather than forwarded. */
const pageLimit = (value: unknown): number => {
  if (value === undefined) return 100;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 200) {
    throw invalid("The media-server request field limit is out of range.");
  }
  return value;
};

const searchTerm = (value: unknown): string | undefined => {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length === 0 || value.length > 256 || CONTROL.test(value) || value.includes("\\")) {
    throw invalid("The media-server search term is not allowed.");
  }
  return value;
};

type MatchProviderName = "imdb" | "tmdb" | "tvdb";

const HAS_PROVIDER_ID_PARAM: Record<MatchProviderName, string> = { imdb: "HasImdbId", tmdb: "HasTmdbId", tvdb: "HasTvdbId" };
const MATCH_PROVIDER_ID: Record<MatchProviderName, RegExp> = {
  imdb: /^tt[0-9]{1,12}$/,
  tmdb: /^[0-9]{1,12}$/,
  tvdb: /^[0-9]{1,12}$/,
};

/** The one catalogue-id shape each provider filter accepts. Anything else is refused before the
 *  value could be spliced into `AnyProviderIdEquals` or a `Has<Name>Id` query. */
const matchProviderId = (value: unknown, name: MatchProviderName): string => {
  if (typeof value !== "string" || !MATCH_PROVIDER_ID[name].test(value)) {
    throw invalid("The media-server provider id is not allowed.");
  }
  return value;
};

const itemTypes = (value: unknown): string => {
  if (typeof value !== "string" || value.length === 0 || value.length > 128) throw invalid("The media-server item types are missing.");
  const tokens = value.split(",");
  if (!tokens.length || tokens.some((token) => !ITEM_TYPES.has(token))) throw invalid("The media-server item types are not allowed.");
  return tokens.join(",");
};

const directoryItemTypes = (value: unknown): string => {
  if (typeof value !== "string" || value.length === 0 || value.length > 128) throw invalid("The media-server item types are missing.");
  const tokens = value.split(",");
  if (!tokens.length || tokens.some((token) => !DIRECTORY_ITEM_TYPES.has(token))) throw invalid("The media-server item types are not allowed.");
  return tokens.join(",");
};

const directorySortBy = (value: unknown): string => {
  if (typeof value !== "string" || !DIRECTORY_SORT_BY.has(value)) throw invalid("The media-server sort is not allowed.");
  return value;
};

const directorySortOrder = (value: unknown): string => {
  if (typeof value !== "string" || !DIRECTORY_SORT_ORDER.has(value)) throw invalid("The media-server sort order is not allowed.");
  return value;
};

const directoryRecursive = (value: unknown): "true" | "false" => {
  if (typeof value !== "boolean") throw invalid("The media-server recursive flag must be a boolean.");
  return value ? "true" : "false";
};

const ORIGINAL_ARGUMENT_KEYS: readonly string[] = ["itemId", "mediaSourceId", "method", "range"];
const ORIGINAL_REQUIRED_KEYS: readonly string[] = ["itemId", "mediaSourceId", "method"];
const CANONICAL_DECIMAL = /^(0|[1-9][0-9]*)$/;
const BYTE_RANGE = /^bytes=(\d*)-(\d*)$/;

/** A canonical, safe decimal integer: no sign, no leading zeros, within the safe integer range. */
function canonicalDecimal(text: string): number {
  if (!CANONICAL_DECIMAL.test(text)) throw invalid("The media-server range is not allowed.");
  const value = Number(text);
  if (!Number.isSafeInteger(value)) throw invalid("The media-server range is not allowed.");
  return value;
}

/** One HTTP byte range, canonicalized to `bytes=N-M`, `bytes=N-` or `bytes=-N`. Whitespace,
 *  multiple ranges, signs, leading zeros, a reversed span, a zero suffix and anything longer than
 *  the bound are all refused, so no caller text can reach the header verbatim. */
function originalRange(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.length > ORIGINAL_RANGE_MAX) {
    throw invalid("The media-server range is not allowed.");
  }
  const match = BYTE_RANGE.exec(value);
  if (!match) throw invalid("The media-server range is not allowed.");
  const [, rawStart, rawEnd] = match;
  if (rawStart === "" && rawEnd === "") throw invalid("The media-server range is not allowed.");
  if (rawStart !== "" && rawEnd !== "") {
    const start = canonicalDecimal(rawStart);
    const end = canonicalDecimal(rawEnd);
    if (end < start) throw invalid("The media-server range is not allowed.");
    return `bytes=${start}-${end}`;
  }
  if (rawStart !== "") return `bytes=${canonicalDecimal(rawStart)}-`;
  const suffix = canonicalDecimal(rawEnd);
  if (suffix <= 0) throw invalid("The media-server range is not allowed.");
  return `bytes=-${suffix}`;
}

/** Reject unknown keys, missing fields, malformed types and an unsupported method before any
 *  network work. The two ids follow the same bounds and escaping rules as every path segment. */
function checkOriginalRequest(args: unknown): OriginalMediaRequest {
  if (typeof args !== "object" || args === null || Array.isArray(args)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(args))
    || Reflect.ownKeys(args).some((key) => typeof key !== "string")) {
    throw invalid("The media-server request arguments are malformed.");
  }
  const record = args as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!ORIGINAL_ARGUMENT_KEYS.includes(key)) throw invalid("The media-server request has an unknown argument.");
  }
  for (const key of ORIGINAL_REQUIRED_KEYS) {
    if (!Object.hasOwn(record, key)) throw invalid(`The media-server request is missing ${key}.`);
  }
  const itemId = pathSegment(record.itemId, "itemId");
  const mediaSourceId = pathSegment(record.mediaSourceId, "mediaSourceId");
  if (record.method !== "GET" && record.method !== "HEAD") throw invalid("The media-server request method is not allowed.");
  const range = record.range === undefined ? undefined : originalRange(record.range);
  return { itemId, mediaSourceId, method: record.method, range };
}

const ASSET_TYPE_MAX = 256;
const ASSET_ARTWORK_MAX_BYTES = 5 * 1024 * 1024;
const ASSET_SUBTITLE_MAX_BYTES = 1 * 1024 * 1024;
const ASSET_SUBTITLE_MAX_INDEX = 1023;
const ASSET_ARTWORK_KEYS: readonly string[] = ["kind", "itemId", "imageType"];
const ASSET_SUBTITLE_KEYS: readonly string[] = ["kind", "itemId", "mediaSourceId", "index"];
const ARTWORK_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);
const SUBTITLE_TYPES = new Set(["text/plain", "application/x-subrip", "application/srt", "text/srt", "application/octet-stream"]);
const MEDIA_TYPE = /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/;
/** One SubRip cue timing line: numeric `hh:mm:ss,mmm --> hh:mm:ss,mmm` with valid minute/second
 *  fields. A body without at least one such line is not a subtitle. */
const SRT_TIMING = /(\d{1,3}):(\d{2}):(\d{2}),(\d{3})\s*-->\s*(\d{1,3}):(\d{2}):(\d{2}),(\d{3})/;

/** Accept only a plain object with exactly the fields one asset kind allows. A symbol key, an
 *  accessor, an inherited or spoofed prototype, an unknown field and a wrong-typed value are all
 *  refused before any DNS or network work. */
function checkAssetRequest(args: unknown): MediaServerAssetRequest {
  if (typeof args !== "object" || args === null || Array.isArray(args)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(args))) {
    throw invalid("The media-server asset request is malformed.");
  }
  for (const key of Reflect.ownKeys(args)) {
    const descriptor = typeof key === "string" ? Object.getOwnPropertyDescriptor(args, key) : undefined;
    if (typeof key !== "string" || !descriptor || !("value" in descriptor)) {
      throw invalid("The media-server asset request is malformed.");
    }
  }
  const record = args as Record<string, unknown>;
  const kind = Object.hasOwn(record, "kind") ? record.kind : undefined;
  if (kind !== "artwork" && kind !== "subtitle") throw invalid("The media-server asset request kind is not allowed.");
  const allowed = kind === "artwork" ? ASSET_ARTWORK_KEYS : ASSET_SUBTITLE_KEYS;
  for (const key of Reflect.ownKeys(record)) {
    if (typeof key !== "string" || !allowed.includes(key)) throw invalid("The media-server asset request has an unknown argument.");
  }
  for (const key of allowed) {
    if (!Object.hasOwn(record, key)) throw invalid(`The media-server asset request is missing ${key}.`);
  }
  const itemId = pathSegment(record.itemId, "itemId");
  if (kind === "artwork") {
    const imageType = record.imageType;
    if (imageType !== "Primary" && imageType !== "Backdrop" && imageType !== "Thumb") throw invalid("The media-server image type is not allowed.");
    return { kind: "artwork", itemId, imageType };
  }
  const mediaSourceId = pathSegment(record.mediaSourceId, "mediaSourceId");
  const index = record.index;
  if (typeof index !== "number" || !Number.isSafeInteger(index) || index < 0 || index > ASSET_SUBTITLE_MAX_INDEX) {
    throw invalid("The media-server subtitle index is out of range.");
  }
  return { kind: "subtitle", itemId, mediaSourceId, index };
}

const ARTWORK_REQUEST_KEYS: readonly string[] = ["itemId", "imageType", "tag", "size"];

/** A plain object with exactly the artwork fields: one bounded item id, one fixed image role, at
 *  most one validated tag and at most one fixed size, `tile` or `detail`. A symbol key, an
 *  accessor, an inherited or spoofed prototype, an unknown field, a wrong-typed value, an invalid
 *  tag or an unsupported size is refused before any DNS or network work. */
function checkArtworkRequest(args: unknown): ArtworkRequest {
  if (typeof args !== "object" || args === null || Array.isArray(args)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(args))) {
    throw invalid("The media-server artwork request is malformed.");
  }
  for (const key of Reflect.ownKeys(args)) {
    const descriptor = typeof key === "string" ? Object.getOwnPropertyDescriptor(args, key) : undefined;
    if (typeof key !== "string" || !descriptor || !("value" in descriptor)) {
      throw invalid("The media-server artwork request is malformed.");
    }
  }
  const record = args as Record<string, unknown>;
  for (const key of Reflect.ownKeys(record)) {
    if (typeof key !== "string" || !ARTWORK_REQUEST_KEYS.includes(key)) {
      throw invalid("The media-server artwork request has an unknown argument.");
    }
  }
  if (!Object.hasOwn(record, "itemId") || !Object.hasOwn(record, "imageType")) {
    throw invalid("The media-server artwork request is missing an argument.");
  }
  const itemId = pathSegment(record.itemId, "itemId");
  const imageType = record.imageType;
  if (imageType !== "Primary" && imageType !== "Backdrop" && imageType !== "Thumb") throw invalid("The media-server image type is not allowed.");
  const rawSize = record.size;
  if (rawSize !== undefined && rawSize !== "tile" && rawSize !== "detail") throw invalid("The media-server artwork size is not allowed.");
  const size: ArtworkRequest["size"] = rawSize === "tile" || rawSize === "detail" ? rawSize : undefined;
  const tag = record.tag === undefined ? undefined : validateArtworkTag(record.tag);
  return {
    itemId,
    imageType,
    ...(tag === undefined ? {} : { tag }),
    ...(size === undefined ? {} : { size }),
  };
}

/** The provider width behind each artwork variant. A request that names no size keeps the legacy
 *  default -- a Backdrop was always fetched at the detail width, a Primary already at the listing
 *  one -- so a client that predates `tile` is served exactly what it was before. */
const artworkMaxWidth = (request: ArtworkRequest): string => {
  // A Thumb is a landscape still the listing already draws small, so it matches the Primary
  // width; only a Backdrop is fetched full width.
  const width = request.size === "tile" ? 640 : request.size === "detail" ? 1920
    : request.imageType === "Backdrop" ? 1920 : 640;
  return String(width);
};

/** The declared media type, lower-cased and stripped of parameters, from a bounded printable
 *  header. It is checked against the kind's allow-list and the actual bytes. */
function assetContentType(value: string | null): string {
  if (value === null || value.length === 0 || value.length > ASSET_TYPE_MAX || !PRINTABLE_HEADER.test(value)) {
    throw invalidResponse("The media server declared an invalid asset type.");
  }
  const semi = value.indexOf(";");
  const type = (semi === -1 ? value : value.slice(0, semi)).trim().toLowerCase();
  if (!MEDIA_TYPE.test(type)) throw invalidResponse("The media server declared an invalid asset type.");
  return type;
}

function assetTypeAllowed(kind: "artwork" | "subtitle", mediaType: string): void {
  const allowed = kind === "artwork" ? ARTWORK_TYPES : SUBTITLE_TYPES;
  if (!allowed.has(mediaType)) {
    throw invalidResponse(`The media server declared an unsupported ${kind} type.`);
  }
}

/** The canonical image type from the leading bytes, or undefined for anything that is not a
 *  permitted raster format. SVG, HTML, GIF and unknown content land on undefined. */
function detectImageType(bytes: Uint8Array): string | undefined {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47
    && bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a) return "image/png";
  if (bytes.length >= 12 && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46
    && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) return "image/webp";
  return undefined;
}

/** A subtitle must decode as UTF-8, carry no NUL and contain at least one valid SubRip timing
 *  line; HTML, JSON, binary or any text without a real time range is refused. */
function checkSubtitleText(bytes: Uint8Array): void {
  if (bytes.includes(0)) throw invalidResponse("The media server subtitle is not text.");
  let text: string;
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch { throw invalidResponse("The media server subtitle is not valid UTF-8 text."); }
  if (/^[<{[]/.test(text.trimStart())) throw invalidResponse("The media server subtitle is not SubRip text.");
  const match = SRT_TIMING.exec(text);
  if (!match || Number(match[2]) > 59 || Number(match[3]) > 59 || Number(match[6]) > 59 || Number(match[7]) > 59) {
    throw invalidResponse("The media server subtitle is not SubRip timing text.");
  }
}

/** Read an asset body under its size cap, watching both the declared length and the running
 *  total. A reader cancel is fired but never awaited so a stuck cancel cannot hold the slot. */
async function readAssetBytes(response: Response, signal: AbortSignal, timedOut: () => boolean, limit: number): Promise<Uint8Array> {
  const body = response.body;
  if (!body) return new Uint8Array(0);
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await guard(reader.read(), signal, timedOut);
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > limit) throw new MediaServerError("response-too-large", "The media server asset is too large.");
      chunks.push(value);
    }
  } catch (error) {
    void reader.cancel().catch(() => undefined);
    throw error;
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
}

/** A test seam may only shorten a deadline, never extend it or invent a non-integer one. */
function seamDeadline(value: unknown, fallback: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0 || value > fallback) {
    throw invalid("The media-server test deadline is invalid.");
  }
  return value;
}

/** Reject unknown, missing or wrong-typed arguments before anything leaves the process. The
 *  unknown-name message is fixed: a property key is untrusted and may itself be a credential. */
function checkArgs<O extends MediaServerOperationName>(operation: O, args: MediaServerOperationArgs[O]): Record<string, unknown> {
  if (typeof args !== "object" || args === null || Array.isArray(args)) throw invalid("The media-server request arguments are malformed.");
  const allowed = ARGUMENT_KEYS[operation];
  for (const key of Object.keys(args as Record<string, unknown>)) {
    if (!allowed.includes(key)) throw invalid("The media-server request has an unknown argument.");
  }
  return args as Record<string, unknown>;
}

const ARGUMENT_KEYS: Record<MediaServerOperationName, readonly string[]> = {
  info: [],
  login: ["username", "password"],
  user: ["userId"],
  views: ["userId"],
  items: ["userId", "parentId", "includeItemTypes", "startIndex", "limit", "searchTerm"],
  directory: ["userId", "parentId", "includeItemTypes", "recursive", "sortBy", "sortOrder", "startIndex", "limit", "searchTerm", "parentIndexNumber", "enableTotalRecordCount"],
  match: ["userId", "parentId", "provider", "providerName", "providerId", "includeItemTypes", "searchTerm", "limit"],
  detail: ["userId", "itemId"],
  ancestors: ["itemId", "userId"],
  versions: ["itemId", "userId"],
};

const REQUIRED_KEYS: Record<MediaServerOperationName, readonly string[]> = {
  info: [],
  login: ["username", "password"],
  user: ["userId"],
  views: ["userId"],
  items: ["userId", "parentId", "includeItemTypes"],
  directory: ["userId", "parentId", "includeItemTypes", "recursive", "sortBy", "sortOrder"],
  match: ["userId", "parentId", "provider", "providerName", "providerId", "includeItemTypes"],
  detail: ["userId", "itemId"],
  ancestors: ["itemId", "userId"],
  versions: ["itemId", "userId"],
};

interface BuiltRequest {
  method: "GET" | "POST";
  url: string;
  token?: string;
  body?: string;
}

/** Turn a validated operation into the exact request line. The URL is assembled from the
 *  normalized base and encoded segments only, so no raw remote path can bypass this. */
function buildRequest(baseUrl: string, operation: MediaServerOperationName, args: Record<string, unknown>): BuiltRequest {
  switch (operation) {
    case "info":
      return { method: "GET", url: `${baseUrl}/System/Info/Public` };
    case "login": {
      if (typeof args.username !== "string" || args.username.length === 0 || args.username.length > 256
        || typeof args.password !== "string" || args.password.length === 0 || args.password.length > 1024) {
        throw invalid("The media-server credentials are malformed.");
      }
      const body = JSON.stringify({ Username: args.username, Pw: args.password });
      if (Buffer.byteLength(body, "utf8") > MEDIA_SERVER_LIMITS.requestBody) throw invalid("The media-server credentials are too large.");
      return { method: "POST", url: `${baseUrl}/Users/AuthenticateByName`, body };
    }
    case "user":
      return { method: "GET", url: `${baseUrl}/Users/${encodeURIComponent(pathSegment(args.userId, "userId"))}` };
    case "views":
      return { method: "GET", url: `${baseUrl}/Users/${encodeURIComponent(pathSegment(args.userId, "userId"))}/Views` };
    case "detail":
      return { method: "GET", url: `${baseUrl}/Users/${encodeURIComponent(pathSegment(args.userId, "userId"))}/Items/${encodeURIComponent(pathSegment(args.itemId, "itemId"))}` };
    case "items": {
      const userId = encodeURIComponent(pathSegment(args.userId, "userId"));
      const query = new URLSearchParams();
      query.set("Recursive", "true");
      query.set("IncludeItemTypes", itemTypes(args.includeItemTypes));
      // SeriesInfo is what makes SeriesId come back on episode rows in the measured
      // Jellyfin 12.2.0 / Emby 4.9.3.0 responses; a row without it is never guessed.
      query.set("Fields", "ProviderIds,ParentId,SeriesInfo");
      query.set("EnableUserData", "false");
      query.set("ParentId", pathSegment(args.parentId, "parentId"));
      query.set("StartIndex", String(boundedIndex(args.startIndex, "startIndex", 1_000_000_000) ?? 0));
      query.set("Limit", String(pageLimit(args.limit)));
      const search = searchTerm(args.searchTerm);
      if (search !== undefined) query.set("SearchTerm", search);
      return { method: "GET", url: `${baseUrl}/Users/${userId}/Items?${query.toString()}` };
    }
    case "directory": {
      const userId = encodeURIComponent(pathSegment(args.userId, "userId"));
      const query = new URLSearchParams();
      query.set("Recursive", directoryRecursive(args.recursive));
      query.set("IncludeItemTypes", directoryItemTypes(args.includeItemTypes));
      // A grid row carries only the facts the listing needs: identity, ancestry, image membership
      // and a child count. Overview and genres are the detail read's job, so the grid stays small.
      query.set("Fields", "ProviderIds,ParentId,SeriesInfo,ImageTags,ChildCount");
      query.set("EnableUserData", "false");
      query.set("ImageTypeLimit", "1");
      query.set("EnableImageTypes", "Primary,Backdrop,Thumb");
      query.set("ParentId", pathSegment(args.parentId, "parentId"));
      query.set("StartIndex", String(boundedIndex(args.startIndex, "startIndex", 1_000_000_000) ?? 0));
      query.set("Limit", String(pageLimit(args.limit)));
      query.set("SortBy", directorySortBy(args.sortBy));
      query.set("SortOrder", directorySortOrder(args.sortOrder));
      const parentIndexNumber = boundedIndex(args.parentIndexNumber, "parentIndexNumber", 1_000_000);
      if (parentIndexNumber !== undefined) query.set("ParentIndexNumber", String(parentIndexNumber));
      if (args.enableTotalRecordCount !== undefined) {
        if (typeof args.enableTotalRecordCount !== "boolean") throw invalid("The media-server total flag must be a boolean.");
        query.set("EnableTotalRecordCount", args.enableTotalRecordCount ? "true" : "false");
      }
      const search = searchTerm(args.searchTerm);
      if (search !== undefined) query.set("SearchTerm", search);
      return { method: "GET", url: `${baseUrl}/Users/${userId}/Items?${query.toString()}` };
    }
    case "match": {
      const userId = encodeURIComponent(pathSegment(args.userId, "userId"));
      if (args.provider !== "jellyfin" && args.provider !== "emby") throw invalid("The media-server match provider is not allowed.");
      if (args.providerName !== "imdb" && args.providerName !== "tmdb" && args.providerName !== "tvdb") {
        throw invalid("The media-server match provider name is not allowed.");
      }
      const providerId = matchProviderId(args.providerId, args.providerName);
      const includeItemTypes = args.includeItemTypes;
      if (includeItemTypes !== "Movie" && includeItemTypes !== "Series") throw invalid("The media-server match item type is not allowed.");
      const query = new URLSearchParams();
      query.set("Recursive", "true");
      query.set("IncludeItemTypes", includeItemTypes);
      query.set("Fields", "ProviderIds,ParentId,SeriesInfo");
      query.set("EnableImages", "false");
      query.set("EnableUserData", "false");
      query.set("EnableTotalRecordCount", "false");
      query.set("ParentId", pathSegment(args.parentId, "parentId"));
      query.set("StartIndex", "0");
      query.set("Limit", String(pageLimit(args.limit)));
      if (args.provider === "emby") {
        // Emby 4.9 answers an exact `AnyProviderIdEquals=imdb.tt...` filter in one list request.
        query.set("AnyProviderIdEquals", `${args.providerName}.${providerId}`);
      } else {
        // Jellyfin 12.2 does not implement AnyProviderIdEquals, so it answers a documented
        // `Has<Name>Id` page; the caller's title narrows it and the ids are re-checked locally.
        query.set(HAS_PROVIDER_ID_PARAM[args.providerName], "true");
        const search = searchTerm(args.searchTerm);
        if (search !== undefined) query.set("SearchTerm", search);
      }
      return { method: "GET", url: `${baseUrl}/Users/${userId}/Items?${query.toString()}` };
    }
    case "ancestors":
      return { method: "GET", url: `${baseUrl}/Items/${encodeURIComponent(pathSegment(args.itemId, "itemId"))}/Ancestors?UserId=${encodeURIComponent(pathSegment(args.userId, "userId"))}` };
    case "versions":
      return { method: "GET", url: `${baseUrl}/Items/${encodeURIComponent(pathSegment(args.itemId, "itemId"))}/PlaybackInfo?UserId=${encodeURIComponent(pathSegment(args.userId, "userId"))}` };
  }
}

/** Map any transport failure -- DNS, socket, redirect or a body stream error -- to a fixed
 *  MediaServerError. A raw upstream message or cause never reaches the caller. */
const mapTransportError = (error: unknown, signal: AbortSignal, timedOut: () => boolean): MediaServerError => {
  if (error instanceof MediaServerError) return error;
  if (signal.aborted) return abortError(timedOut());
  const cause = (error as { cause?: unknown } | null)?.cause;
  if (cause instanceof MediaServerError) return cause;
  const redirect = (value: unknown): boolean =>
    value instanceof Error && (value.message === "unexpected redirect" || value.message.includes("redirect"));
  if (redirect(error) || redirect(cause)) {
    return new MediaServerError("invalid-response", "The media server redirected the request.");
  }
  return new MediaServerError("unavailable", "The media server could not be reached.");
};

export function createMediaServerTransport(
  config: MediaServerTransportConfig,
  seams: MediaServerTransportSeams = {},
): MediaServerTransport {
  const policy: MediaServerAddressPolicy = checkPolicy({ allowLan: config.allowLan, allowLoopback: config.allowLoopback });
  const baseUrl = normalizeMediaServerUrl(config.baseUrl);
  const deviceId = config.deviceId ?? DEVICE_ID;
  if (typeof deviceId !== "string" || !/^[a-zA-Z0-9_-]{1,64}$/.test(deviceId)) throw invalid("The media-server device identity is invalid.");
  const resolveAll = seams.lookupAll ?? systemLookupAll;
  let pendingLookups = 0;
  const lookupAll: LookupAll = (hostname, options) => {
    if (pendingLookups >= MAX_CONCURRENCY) {
      return Promise.reject(new MediaServerError("busy", "Too many media-server DNS lookups are in flight."));
    }
    pendingLookups += 1;
    // DNS work cannot be cancelled; keep its slot until the resolver actually settles.
    return Promise.resolve().then(() => resolveAll(hostname, options)).finally(() => { pendingLookups -= 1; });
  };
  let pendingImageLookups = 0;
  const lookupImageAll: LookupAll = (hostname, options) => {
    if (pendingImageLookups >= IMAGE_DNS_MAX) {
      return Promise.reject(new MediaServerError("busy", "Too many media-server image lookups are in flight."));
    }
    pendingImageLookups += 1;
    return Promise.resolve().then(() => resolveAll(hostname, options)).finally(() => { pendingImageLookups -= 1; });
  };

  const literalHost = new URL(baseUrl).hostname.replace(/^\[|\]$/g, "");
  if (net.isIP(literalHost)) assertMediaServerAddress(literalHost, policy);

  const active = new Set<AbortController>();
  const agents = new Set<Agent>();
  /** Live artwork streams, each holding one of the thirty-two image slots until it is released. */
  const images = new Set<{ controller: AbortController; abort: () => void }>();
  /** One reusable agent for artwork: its pooled TLS connections outlive any single image, so a
   *  burst of posters reuses connections instead of opening one handshake per JPEG. */
  let imageAgent: Agent | undefined;
  let closed = false;
  // A 429 parks every later request from this transport until the cooldown expires. It is only
  // cleared by time passing or by rebuilding the transport, never by a request of our own.
  let cooldownUntil = 0;

  /** Arm the cooldown from a 429 and report the delay actually applied (bounded by the cap). */
  const enterCooldown = (retryAfterMs: number | undefined): number => {
    const delay = Math.min(retryAfterMs ?? COOLDOWN_DEFAULT_MS, MAX_RETRY_AFTER_MS);
    cooldownUntil = Math.max(cooldownUntil, Date.now() + delay);
    return delay;
  };

  /** The rejection a request gets while the transport is cooling down, or undefined when the
   *  cooldown has expired. It is answered locally with the remaining hint, before any DNS work. */
  const coolingError = (): MediaServerError | undefined => {
    const remaining = cooldownUntil - Date.now();
    if (remaining <= 0) return undefined;
    return new MediaServerError("rate-limited", "The media server is rate limiting requests.", 429, remaining);
  };

  /** A non-ok status: a 429 arms the cooldown and reports the applied delay; every other status
   *  keeps its existing mapping. */
  const statusFailure = (status: number, headers: Headers): MediaServerError => {
    if (status === 429) return new MediaServerError("rate-limited", "The media server is rate limiting requests.", 429, enterCooldown(parseRetryAfter(headers.get("retry-after"))));
    return statusError(status, headers);
  };

  /** Socket lookup shares its own request deadline; another live request cannot extend it. */
  const createLookup = (signal: AbortSignal, timedOut: () => boolean) => (hostname: string, options: LookupOptions, callback: (error: NodeJS.ErrnoException | null, address?: string | LookupAddress[], family?: number) => void): void => {
    const refused = lookupFailure() as unknown as NodeJS.ErrnoException;
    if (closed || signal.aborted) { callback(refused); return; }
    const family = typeof options?.family === "number" ? options.family : 0;
    guard(Promise.resolve().then(() => {
      if (closed || signal.aborted) throw abortError(timedOut());
      return lookupAll(hostname, { all: true });
    }), signal, timedOut)
      .then((answers) => {
        if (closed || signal.aborted) throw abortError(timedOut());
        const checked = checkedAnswers(answers, policy);
        let list = checked;
        if (family === 4) list = list.filter((answer) => answer.family === 4);
        else if (family === 6) list = list.filter((answer) => answer.family === 6);
        if (!list.length) throw lookupFailure();
        if (options?.all) callback(null, list);
        else callback(null, list[0].address, list[0].family);
      })
      .catch((error: unknown) => callback(error instanceof MediaServerError ? error as unknown as NodeJS.ErrnoException : refused));
  };

  async function validateHost(hostname: string, signal: AbortSignal, timedOut: () => boolean): Promise<void> {
    if (signal.aborted) throw abortError(timedOut());
    if (net.isIP(hostname)) { assertMediaServerAddress(hostname, policy); return; }
    let answers: unknown;
    try {
      answers = await guard(lookupAll(hostname, { all: true }), signal, timedOut);
    } catch (error) {
      if (error instanceof MediaServerError) throw error;
      throw lookupFailure();
    }
    checkedAnswers(answers, policy);
  }

  /** The reusable image agent's lookup: it validates answers against the same address policy, but
   *  because the agent outlives one request it can never borrow that request's AbortSignal. It
   *  carries its own single-lookup deadline and its own DNS counter instead. */
  const imageLookup = (hostname: string, options: LookupOptions, callback: (error: NodeJS.ErrnoException | null, address?: string | LookupAddress[], family?: number) => void): void => {
    const refused = lookupFailure() as unknown as NodeJS.ErrnoException;
    if (closed) { callback(refused); return; }
    const family = typeof options?.family === "number" ? options.family : 0;
    const controller = new AbortController();
    const deadline = setTimeout(() => controller.abort(), DEADLINE_MS);
    guard(Promise.resolve().then(() => lookupImageAll(hostname, { all: true })), controller.signal, () => true)
      .then((answers) => {
        clearTimeout(deadline);
        if (closed) throw abortError(false);
        const checked = checkedAnswers(answers, policy);
        let list = checked;
        if (family === 4) list = list.filter((answer) => answer.family === 4);
        else if (family === 6) list = list.filter((answer) => answer.family === 6);
        if (!list.length) throw lookupFailure();
        if (options?.all) callback(null, list);
        else callback(null, list[0].address, list[0].family);
      })
      .catch((error: unknown) => {
        clearTimeout(deadline);
        callback(error instanceof MediaServerError ? error as unknown as NodeJS.ErrnoException : refused);
      });
  };

  const ensureImageAgent = (): Agent | undefined => {
    if (seams.fetch) return undefined;
    if (!imageAgent) {
      imageAgent = new Agent({ connect: { ...seams.connectOptions, lookup: imageLookup as unknown as import("node:net").LookupFunction } });
      agents.add(imageAgent);
    }
    return imageAgent;
  };

  /** The pre-flight image host check runs on the image DNS counter, so it never occupies one of the
   *  four metadata lookup slots. */
  async function validateImageHost(hostname: string, signal: AbortSignal, timedOut: () => boolean): Promise<void> {
    if (signal.aborted) throw abortError(timedOut());
    if (net.isIP(hostname)) { assertMediaServerAddress(hostname, policy); return; }
    let answers: unknown;
    try {
      answers = await guard(lookupImageAll(hostname, { all: true }), signal, timedOut);
    } catch (error) {
      if (error instanceof MediaServerError) throw error;
      throw lookupFailure();
    }
    checkedAnswers(answers, policy);
  }

  /** Read the body incrementally under the size cap. A reader cancel is fired but never
   *  awaited: a never-settling cancel must not hold the slot or the deadline open. */
  async function readBounded(response: Response, signal: AbortSignal, timedOut: () => boolean): Promise<string> {
    const body = response.body;
    if (!body) return "";
    const reader = body.getReader();
    const chunks: Buffer[] = [];
    let total = 0;
    try {
      for (;;) {
        const { done, value } = await guard(reader.read(), signal, timedOut);
        if (done) break;
        if (!value) continue;
        total += value.byteLength;
        if (total > MEDIA_SERVER_LIMITS.responseBody) throw new MediaServerError("response-too-large", "The media server response was too large.");
        chunks.push(Buffer.from(value));
      }
    } catch (error) {
      void reader.cancel().catch(() => undefined);
      throw mapTransportError(error, signal, timedOut);
    }
    return Buffer.concat(chunks).toString("utf8");
  }

  async function requestJson<O extends MediaServerOperationName>(
    operation: O,
    args: MediaServerOperationArgs[O],
    token?: string,
    signal?: AbortSignal,
  ): Promise<unknown> {
    if (!Object.hasOwn(ARGUMENT_KEYS, operation)) throw invalid("The media-server operation is not allowed.");
    const checked = checkArgs(operation, args);
    for (const key of REQUIRED_KEYS[operation]) if (!Object.hasOwn(checked, key)) throw invalid(`The media-server request is missing ${key}.`);
    const bearer = token === undefined ? undefined : validateMediaServerToken(token);
    if (bearer === undefined && operation !== "info" && operation !== "login") {
      throw new MediaServerError("authentication-required", "The media-server request needs a token.");
    }
    const built = buildRequest(baseUrl, operation, checked);

    if (closed) throw new MediaServerError("closed", "The media-server transport is closed.");
    const cooling = coolingError();
    if (cooling) throw cooling;
    if (active.size >= MAX_CONCURRENCY) throw new MediaServerError("busy", "Too many media-server requests are in flight.");

    const controller = new AbortController();
    let timedOut = false;
    const timeout = setTimeout(() => { timedOut = true; controller.abort(); }, DEADLINE_MS);
    const onAbort = () => controller.abort();
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) controller.abort();
    const isTimedOut = () => timedOut;
    active.add(controller);
    let agent: Agent | undefined;

    try {
      await validateHost(new URL(built.url).hostname.replace(/^\[|\]$/g, ""), controller.signal, isTimedOut);
      if (closed) throw new MediaServerError("closed", "The media-server transport is closed.");
      if (controller.signal.aborted) throw abortError(isTimedOut());

      const headers: Record<string, string> = {
        accept: "application/json",
        authorization: `MediaBrowser Client="${CLIENT}", Device="${DEVICE}", DeviceId="${deviceId}", Version="${CLIENT_VERSION}"`,
      };
      if (built.body !== undefined) headers["content-type"] = "application/json";
      if (bearer !== undefined) {
        headers.authorization += `, Token="${bearer}"`;
        headers["x-emby-token"] = bearer;
      }
      const init: RequestInit = { method: built.method, headers, redirect: "error" };
      if (built.body !== undefined) init.body = built.body;

      let response: Response;
      try {
        // A socket lookup belongs to this request, even while other requests remain live.
        if (!seams.fetch) {
          agent = new Agent({ connect: { ...seams.connectOptions, lookup: createLookup(controller.signal, isTimedOut) as unknown as import("node:net").LookupFunction } });
          agents.add(agent);
        }
        const sendFetch: MediaServerFetch = seams.fetch ?? ((url, options) =>
          undiciFetch(url, { ...options, dispatcher: agent } as Parameters<typeof undiciFetch>[1]) as unknown as Promise<Response>);
        // Recheck now: a 429 observed by another request while this one prepared must stop it
        // before the socket is touched.
        const lateCooling = coolingError();
        if (lateCooling) throw lateCooling;
        // Counted here, not where the call was asked for: past the cooling re-check and about to
        // reach the socket. A request that then fails to connect or answers 404 is still a call
        // that left this process, and the counter is for those.
        noteProviderCall(operation);
        response = await guard(sendFetch(built.url, { ...init, signal: controller.signal }), controller.signal, isTimedOut);
      } catch (error) {
        throw mapTransportError(error, controller.signal, isTimedOut);
      }
      if (!response.ok) {
        void response.body?.cancel().catch(() => undefined);
        throw statusFailure(response.status, new Headers(response.headers));
      }
      const text = await readBounded(response, controller.signal, isTimedOut);
      try { return JSON.parse(text); }
      catch { throw new MediaServerError("invalid-response", "The media server did not answer with JSON."); }
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", onAbort);
      active.delete(controller);
      controller.abort();
      if (agent) {
        await agent.destroy().catch(() => undefined);
        agents.delete(agent);
      }
    }
  }

  const originalHeaderMs = seamDeadline(seams.originalHeaderMs, ORIGINAL_HEADER_MS);
  const originalIdleMs = seamDeadline(seams.originalIdleMs, ORIGINAL_IDLE_MS);
  const originalLifetimeMs = seamDeadline(seams.originalLifetimeMs, ORIGINAL_LIFETIME_MS);
  const imageHeaderMs = seamDeadline(seams.imageHeaderMs, IMAGE_HEADER_MS);
  const imageIdleMs = seamDeadline(seams.imageIdleMs, IMAGE_IDLE_MS);
  const imageLifetimeMs = seamDeadline(seams.imageLifetimeMs, IMAGE_LIFETIME_MS);

  interface OriginalRecord {
    controller: AbortController;
    abort: () => void;
  }
  const originals = new Set<OriginalRecord>();

  /** Stream one original media file through the same DNS/socket guard as metadata, under a
   *  separate 8-request pool. The returned Response resolves once headers are validated; its
   *  slot, agent and controller live until the body completes, is cancelled, errors or the
   *  transport closes -- never only until the headers. */
  async function requestOriginal(args: OriginalMediaRequest, token: string, signal?: AbortSignal): Promise<Response> {
    let request = checkOriginalRequest(args);
    const bearer = validateMediaServerToken(token);
    if (request.range?.startsWith("bytes=-")) {
      // Emby 4.9 treats suffix ranges as offsets from zero; send an explicit measured span.
      const head = await requestOriginal({ itemId: request.itemId, mediaSourceId: request.mediaSourceId, method: "HEAD" }, bearer, signal);
      const rawLength = head.headers.get("content-length");
      if (rawLength === null) throw invalidResponse("The media server did not provide the original length.");
      const length = Number(rawLength);
      if (length === 0) return new Response(null, { status: 416, headers: { "content-range": "bytes */0" } });
      request = { ...request, range: `bytes=${Math.max(0, length - Number(request.range.slice(7)))}-${length - 1}` };
    }
    // Only the fixed static original-file path is ever built: the normalized base, an encoded
    // item segment and a fixed `/stream` with fixed Static/MediaSourceId query entries.
    const url = `${baseUrl}/Videos/${encodeURIComponent(request.itemId)}/stream?Static=true&MediaSourceId=${encodeURIComponent(request.mediaSourceId)}`;

    if (closed) throw new MediaServerError("closed", "The media-server transport is closed.");
    const cooling = coolingError();
    if (cooling) throw cooling;
    if (originals.size >= ORIGINAL_MAX_CONCURRENCY) {
      throw new MediaServerError("busy", "Too many media-server streams are in flight.");
    }

    const controller = new AbortController();
    let failure: MediaServerError | undefined;
    const isTimedOut = (): boolean => failure?.code === "timeout";
    const abortWith = (error: MediaServerError): void => {
      if (!failure) failure = error;
      controller.abort();
    };
    const onAbort = (): void => abortWith(new MediaServerError("cancelled", "The media-server request was cancelled."));
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();

    const headerTimer = setTimeout(
      () => abortWith(new MediaServerError("timeout", "The media server did not answer in time.")),
      originalHeaderMs,
    );
    const lifetimeTimer = setTimeout(
      () => abortWith(new MediaServerError("timeout", "The media-server stream exceeded its lifetime.")),
      originalLifetimeMs,
    );
    let idleTimer: NodeJS.Timeout | undefined;

    let agent: Agent | undefined;
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let upstreamBody: ReadableStream<Uint8Array> | null = null;
    let downstream: ReadableStreamDefaultController<Uint8Array> | undefined;
    let released = false;
    const record: OriginalRecord = {
      controller,
      abort: () => abortWith(new MediaServerError("closed", "The media-server transport is closed.")),
    };
    originals.add(record);

    /** Release exactly once: clear every deadline, drop the slot and the agent, and abort the
     *  upstream request. A never-settling reader cancel is fired but never awaited. */
    const release = (): void => {
      if (released) return;
      released = true;
      clearTimeout(headerTimer);
      clearTimeout(lifetimeTimer);
      clearTimeout(idleTimer);
      signal?.removeEventListener("abort", onAbort);
      controller.signal.removeEventListener("abort", terminate);
      void (reader ? reader.cancel() : upstreamBody?.cancel())?.catch(() => undefined);
      originals.delete(record);
      controller.abort();
      if (agent) {
        agents.delete(agent);
        void agent.destroy().catch(() => undefined);
      }
    };

    const terminate = (): void => {
      if (released) return;
      const error = failure ?? new MediaServerError("cancelled", "The media-server request was cancelled.");
      release();
      downstream?.error(error);
    };
    controller.signal.addEventListener("abort", terminate, { once: true });

    try {
      await validateHost(new URL(url).hostname.replace(/^\[|\]$/g, ""), controller.signal, isTimedOut);
      if (closed) throw new MediaServerError("closed", "The media-server transport is closed.");
      if (controller.signal.aborted) throw failure ?? new MediaServerError("cancelled", "The media-server request was cancelled.");

      const headers: Record<string, string> = {
        accept: "application/octet-stream",
        "accept-encoding": "identity",
        authorization: `MediaBrowser Client="${CLIENT}", Device="${DEVICE}", DeviceId="${deviceId}", Version="${CLIENT_VERSION}", Token="${bearer}"`,
        "x-emby-token": bearer,
      };
      if (request.range !== undefined) headers.range = request.range;
      const init: RequestInit = { method: request.method, headers, redirect: "error" };

      if (!seams.fetch) {
        agent = new Agent({ connect: { ...seams.connectOptions, lookup: createLookup(controller.signal, isTimedOut) as unknown as import("node:net").LookupFunction } });
        agents.add(agent);
      }
      const sendFetch: MediaServerFetch = seams.fetch ?? ((target, options) =>
        undiciFetch(target, { ...options, dispatcher: agent } as Parameters<typeof undiciFetch>[1]) as unknown as Promise<Response>);
      // Recheck now: a 429 observed while this stream was being prepared must stop it here.
      const lateCooling = coolingError();
      if (lateCooling) throw lateCooling;
      noteProviderCall("original");
      const response = await guard(sendFetch(url, { ...init, signal: controller.signal }), controller.signal, isTimedOut);
      upstreamBody = response.body;
      clearTimeout(headerTimer);

      const status = response.status;
      if (status !== 200 && status !== 206 && status !== 416) {
        void response.body?.cancel().catch(() => undefined);
        throw statusFailure(status, new Headers(response.headers));
      }
      const upstream = new Headers(response.headers);
      // `accept-encoding: identity` is a request preference; if the server compressed anyway the
      // bytes are a transformation we must refuse rather than forward silently.
      if (status !== 416) {
        const encoding = upstream.get("content-encoding");
        if (encoding !== null && encoding.trim().toLowerCase() !== "identity") {
          void response.body?.cancel().catch(() => undefined);
          throw invalidResponse("The media server transformed the media stream.");
        }
      }

      if (status === 416) {
        const total = unsatisfiedContentRange(upstream.get("content-range"));
        void response.body?.cancel().catch(() => undefined);
        const out = new Headers();
        out.set("content-range", `bytes */${total}`);
        const acceptRanges = normalizedAcceptRanges(upstream.get("accept-ranges"));
        if (acceptRanges) out.set("accept-ranges", acceptRanges);
        release();
        return new Response(null, { status: 416, headers: out });
      }

      const out = sanitizedMediaHeaders(status, upstream);
      if (status === 206) {
        const span = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(out.get("content-range") ?? "")!;
        const [start, end, total] = span.slice(1).map(Number);
        const range = /^bytes=(\d*)-(\d*)$/.exec(request.range ?? "");
        if (!range) throw invalidResponse("The media server sent an unrequested range.");
        const expectedStart = range[1] ? Number(range[1]) : Math.max(0, total! - Number(range[2]));
        // The server may answer with a shorter or longer span than the one asked for; only a
        // body that begins at another offset is a different answer.
        if (start !== expectedStart || start > end || end >= total!) throw invalidResponse("The media server answered a different range.");
      }
      if (request.method === "HEAD") {
        void response.body?.cancel().catch(() => undefined);
        release();
        return new Response(null, { status, headers: out });
      }

      const body = response.body;
      if (!body) throw invalidResponse("The media server sent no media body.");
      reader = body.getReader();
      const expected = out.has("content-length") ? Number(out.get("content-length"))
        : status === 206 ? (() => { const span = /^bytes (\d+)-(\d+)\//.exec(out.get("content-range")!)!; return Number(span[2]) - Number(span[1]) + 1; })()
        : undefined;
      let delivered = 0;
      const armIdle = (): void => {
        clearTimeout(idleTimer);
        idleTimer = setTimeout(() => abortWith(new MediaServerError("timeout", "The media server stopped sending data.")), originalIdleMs);
      };
      const stream = new ReadableStream<Uint8Array>({
        start(value) { downstream = value; },
        async pull(downstream) {
          if (released) return;
          armIdle();
          let result: ReadableStreamReadResult<Uint8Array>;
          try {
            result = await guard(reader!.read(), controller.signal, isTimedOut);
          } catch (error) {
            // A cancel or a close may have released the slot while this read was pending; the
            // stream is already settled, so there is nothing left to report.
            if (released) return;
            clearTimeout(idleTimer);
            const mapped = failure ?? mapTransportError(error, controller.signal, isTimedOut);
            release();
            downstream.error(mapped);
            return;
          }
          if (released) return;
          clearTimeout(idleTimer);
          if (result.done) {
            release();
            if (expected !== undefined && delivered !== expected) {
              downstream.error(invalidResponse("The media server ended the media stream early."));
              return;
            }
            downstream.close();
            return;
          }
          if (result.value) {
            delivered += result.value.byteLength;
            if (expected !== undefined && delivered > expected) {
              release();
              downstream.error(invalidResponse("The media server sent too many media bytes."));
              return;
            }
            downstream.enqueue(result.value);
          }
        },
        cancel() {
          clearTimeout(idleTimer);
          void reader!.cancel().catch(() => undefined);
          abortWith(new MediaServerError("cancelled", "The media-server request was cancelled."));
          release();
        },
      });
      return new Response(stream, { status, headers: out });
    } catch (error) {
      // Map the failure before releasing: release aborts the controller, and an aborted signal
      // must not turn a redirect or an upstream error into a plain cancel.
      const mapped = failure ?? mapTransportError(error, controller.signal, isTimedOut);
      release();
      throw mapped;
    }
  }

  /** Stream one validated artwork image under the artwork pool's thirty-two slots -- never a
   *  metadata or original slot, and never the metadata DNS counter. Headers are validated before
   *  the Response is returned; the first image bytes follow on their own pull, so a caller can
   *  start showing a poster before the rest of the JPEG arrives. The slot, controller and idle
   *  deadline live until the body finishes, is cancelled, errors or the transport closes. */
  async function requestArtwork(args: ArtworkRequest, token: string, signal?: AbortSignal): Promise<Response> {
    const request = checkArtworkRequest(args);
    const bearer = validateMediaServerToken(token);
    const query = new URLSearchParams();
    if (request.tag !== undefined) query.set("tag", request.tag);
    query.set("MaxWidth", artworkMaxWidth(request));
    query.set("Quality", "85");
    query.set("Format", "Jpg");
    const url = `${baseUrl}/Items/${encodeURIComponent(request.itemId)}/Images/${request.imageType}?${query.toString()}`;

    if (closed) throw new MediaServerError("closed", "The media-server transport is closed.");
    const cooling = coolingError();
    if (cooling) throw cooling;
    if (images.size >= IMAGE_MAX_CONCURRENCY) throw new MediaServerError("busy", "Too many media-server images are in flight.");

    const controller = new AbortController();
    let failure: MediaServerError | undefined;
    const isTimedOut = (): boolean => failure?.code === "timeout";
    const abortWith = (error: MediaServerError): void => {
      if (!failure) failure = error;
      controller.abort();
    };
    const onAbort = (): void => abortWith(new MediaServerError("cancelled", "The media-server request was cancelled."));
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();

    const headerTimer = setTimeout(
      () => abortWith(new MediaServerError("timeout", "The media server did not answer in time.")),
      imageHeaderMs,
    );
    const lifetimeTimer = setTimeout(
      () => abortWith(new MediaServerError("timeout", "The media-server image exceeded its lifetime.")),
      imageLifetimeMs,
    );
    let idleTimer: NodeJS.Timeout | undefined;

    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let upstreamBody: ReadableStream<Uint8Array> | null = null;
    let downstream: ReadableStreamDefaultController<Uint8Array> | undefined;
    let released = false;
    const record = {
      controller,
      abort: () => abortWith(new MediaServerError("closed", "The media-server transport is closed.")),
    };
    images.add(record);

    /** Release exactly once: clear every deadline, drop the slot and abort the upstream request.
     *  The shared image agent is deliberately not destroyed here -- it outlives one image. */
    const release = (): void => {
      if (released) return;
      released = true;
      clearTimeout(headerTimer);
      clearTimeout(lifetimeTimer);
      clearTimeout(idleTimer);
      signal?.removeEventListener("abort", onAbort);
      controller.signal.removeEventListener("abort", terminate);
      void (reader ? reader.cancel() : upstreamBody?.cancel())?.catch(() => undefined);
      images.delete(record);
      controller.abort();
    };

    const terminate = (): void => {
      if (released) return;
      const error = failure ?? new MediaServerError("cancelled", "The media-server request was cancelled.");
      release();
      downstream?.error(error);
    };
    controller.signal.addEventListener("abort", terminate, { once: true });

    try {
      await validateImageHost(new URL(url).hostname.replace(/^\[|\]$/g, ""), controller.signal, isTimedOut);
      if (closed) throw new MediaServerError("closed", "The media-server transport is closed.");
      if (controller.signal.aborted) throw failure ?? new MediaServerError("cancelled", "The media-server request was cancelled.");

      const headers: Record<string, string> = {
        accept: "image/*",
        "accept-encoding": "identity",
        authorization: `MediaBrowser Client="${CLIENT}", Device="${DEVICE}", DeviceId="${deviceId}", Version="${CLIENT_VERSION}", Token="${bearer}"`,
        "x-emby-token": bearer,
      };
      const init: RequestInit = { method: "GET", headers, redirect: "error" };
      const dispatcher = ensureImageAgent();
      const sendFetch: MediaServerFetch = seams.fetch ?? ((target, options) =>
        undiciFetch(target, { ...options, dispatcher } as Parameters<typeof undiciFetch>[1]) as unknown as Promise<Response>);
      // Recheck now: a 429 observed while this image was preparing must stop it before the socket.
      const lateCooling = coolingError();
      if (lateCooling) throw lateCooling;
      noteProviderCall("artwork");
      const response = await guard(sendFetch(url, { ...init, signal: controller.signal }), controller.signal, isTimedOut);
      upstreamBody = response.body;
      clearTimeout(headerTimer);

      if (response.status !== 200) {
        void response.body?.cancel().catch(() => undefined);
        throw statusFailure(response.status, new Headers(response.headers));
      }
      const upstream = new Headers(response.headers);
      const encoding = upstream.get("content-encoding");
      if (encoding !== null && encoding.trim().toLowerCase() !== "identity") {
        void response.body?.cancel().catch(() => undefined);
        throw invalidResponse("The media server transformed the image.");
      }
      const declared = contentLengthValue(upstream.get("content-length"));
      if (declared !== undefined && declared > IMAGE_MAX_BYTES) {
        void response.body?.cancel().catch(() => undefined);
        throw new MediaServerError("response-too-large", "The media server image is too large.");
      }
      const mediaType = assetContentType(upstream.get("content-type"));
      assetTypeAllowed("artwork", mediaType);

      // Only a validated image content type and its declared length leave the transport; the
      // upstream ETag/Last-Modified, server identity and every other header are dropped.
      const out = new Headers();
      out.set("content-type", mediaType);
      if (declared !== undefined) out.set("content-length", String(declared));

      const body = response.body;
      if (!body) throw invalidResponse("The media server sent no image body.");
      reader = body.getReader();
      let delivered = 0;
      let sniffed = false;
      const prefix: Uint8Array[] = [];
      let prefixLength = 0;
      const armIdle = (): void => {
        clearTimeout(idleTimer);
        idleTimer = setTimeout(() => abortWith(new MediaServerError("timeout", "The media server stopped sending data.")), imageIdleMs);
      };
      const stream = new ReadableStream<Uint8Array>({
        start(value) { downstream = value; },
        async pull(pullDownstream) {
          while (!released) {
            armIdle();
            let result: ReadableStreamReadResult<Uint8Array>;
            try {
              result = await guard(reader!.read(), controller.signal, isTimedOut);
            } catch (error) {
              if (released) return;
              clearTimeout(idleTimer);
              const mapped = failure ?? mapTransportError(error, controller.signal, isTimedOut);
              release();
              pullDownstream.error(mapped);
              return;
            }
            if (released) return;
            clearTimeout(idleTimer);
            if (result.done) {
              release();
              if (!sniffed) {
                pullDownstream.error(invalidResponse("The media server sent content that is not a supported image."));
                return;
              }
              if (declared !== undefined && delivered !== declared) {
                pullDownstream.error(invalidResponse("The media server ended the image early."));
                return;
              }
              pullDownstream.close();
              return;
            }
            if (!result.value) continue;
            if (declared !== undefined && delivered + prefixLength + result.value.byteLength > declared) {
              release();
              pullDownstream.error(invalidResponse("The media server sent too many image bytes."));
              return;
            }
            if (delivered + prefixLength + result.value.byteLength > IMAGE_MAX_BYTES) {
              release();
              pullDownstream.error(new MediaServerError("response-too-large", "The media server image is too large."));
              return;
            }
            // The declared type is trusted only once the leading bytes agree with it: a body whose
            // magic bytes are not a permitted raster format never reaches the client.
            if (!sniffed) {
              prefix.push(result.value);
              prefixLength += result.value.byteLength;
              if (prefixLength < 12) continue;
              const head = new Uint8Array(prefixLength);
              let offset = 0;
              for (const chunk of prefix) { head.set(chunk, offset); offset += chunk.byteLength; }
              const detected = detectImageType(head);
              if (!detected || detected !== mediaType) {
                release();
                pullDownstream.error(invalidResponse("The media server image does not match its content."));
                return;
              }
              sniffed = true;
              prefixLength = 0;
              prefix.length = 0;
              delivered += head.byteLength;
              if (delivered > IMAGE_MAX_BYTES) {
                release();
                pullDownstream.error(new MediaServerError("response-too-large", "The media server image is too large."));
                return;
              }
              pullDownstream.enqueue(head);
              return;
            }
            delivered += result.value.byteLength;
            if (delivered > IMAGE_MAX_BYTES) {
              release();
              pullDownstream.error(new MediaServerError("response-too-large", "The media server image is too large."));
              return;
            }
            pullDownstream.enqueue(result.value);
            return;
          }
        },
        cancel() {
          clearTimeout(idleTimer);
          void reader!.cancel().catch(() => undefined);
          abortWith(new MediaServerError("cancelled", "The media-server request was cancelled."));
          release();
        },
      });
      return new Response(stream, { status: 200, headers: out });
    } catch (error) {
      // Map the failure before releasing: release aborts the controller, and an aborted signal
      // must not turn a redirect or an upstream error into a plain cancel.
      const mapped = failure ?? mapTransportError(error, controller.signal, isTimedOut);
      release();
      throw mapped;
    }
  }

  /** Fetch one fixed artwork image or subtitle track through the same connection, DNS, socket and
   *  redirect guard as metadata, under the metadata pool's four slots and single deadline. The
   *  body is read incrementally under its kind's cap and validated before it is returned. */
  async function requestAsset(request: MediaServerAssetRequest, token: string, signal?: AbortSignal): Promise<MediaServerAsset> {
    const checked = checkAssetRequest(request);
    const bearer = validateMediaServerToken(token);
    const limit = checked.kind === "artwork" ? ASSET_ARTWORK_MAX_BYTES : ASSET_SUBTITLE_MAX_BYTES;
    const url = checked.kind === "artwork"
      ? `${baseUrl}/Items/${encodeURIComponent(checked.itemId)}/Images/${checked.imageType}?MaxWidth=${checked.imageType === "Backdrop" ? "1920" : "640"}&Quality=85&Format=Jpg`
      : `${baseUrl}/Videos/${encodeURIComponent(checked.itemId)}/${encodeURIComponent(checked.mediaSourceId)}/Subtitles/${checked.index}/Stream.srt`;

    if (closed) throw new MediaServerError("closed", "The media-server transport is closed.");
    const cooling = coolingError();
    if (cooling) throw cooling;
    if (active.size >= MAX_CONCURRENCY) throw new MediaServerError("busy", "Too many media-server requests are in flight.");

    const controller = new AbortController();
    let failure: MediaServerError | undefined;
    const isTimedOut = (): boolean => failure?.code === "timeout";
    const abortWith = (error: MediaServerError): void => {
      if (!failure) failure = error;
      controller.abort();
    };
    const onAbort = (): void => abortWith(new MediaServerError("cancelled", "The media-server request was cancelled."));
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
    const timeout = setTimeout(
      () => abortWith(new MediaServerError("timeout", "The media server did not answer in time.")),
      DEADLINE_MS,
    );
    active.add(controller);
    let agent: Agent | undefined;

    try {
      await validateHost(new URL(url).hostname.replace(/^\[|\]$/g, ""), controller.signal, isTimedOut);
      if (closed) throw new MediaServerError("closed", "The media-server transport is closed.");
      if (controller.signal.aborted) throw failure ?? abortError(isTimedOut());

      const headers: Record<string, string> = {
        accept: checked.kind === "artwork" ? "image/*" : "text/plain",
        "accept-encoding": "identity",
        authorization: `MediaBrowser Client="${CLIENT}", Device="${DEVICE}", DeviceId="${deviceId}", Version="${CLIENT_VERSION}", Token="${bearer}"`,
        "x-emby-token": bearer,
      };
      const init: RequestInit = { method: "GET", headers, redirect: "error" };

      if (!seams.fetch) {
        agent = new Agent({ connect: { ...seams.connectOptions, lookup: createLookup(controller.signal, isTimedOut) as unknown as import("node:net").LookupFunction } });
        agents.add(agent);
      }
      const sendFetch: MediaServerFetch = seams.fetch ?? ((target, options) =>
        undiciFetch(target, { ...options, dispatcher: agent } as Parameters<typeof undiciFetch>[1]) as unknown as Promise<Response>);
      // A fetch that settles only after the abort or deadline is lost to the guard, so its body
      // is cancelled here rather than left open.
      const lateCooling = coolingError();
      if (lateCooling) throw lateCooling;
      noteProviderCall(checked.kind === "subtitle" ? "subtitle" : "artwork");
      const response = await guard(
        sendFetch(url, { ...init, signal: controller.signal }).then((value) => {
          if (controller.signal.aborted) {
            void value.body?.cancel().catch(() => undefined);
            throw failure ?? abortError(isTimedOut());
          }
          return value;
        }),
        controller.signal,
        isTimedOut,
      );

      const upstream = new Headers(response.headers);
      let mediaType = "";
      let declared: number | undefined;
      try {
        if (response.status !== 200) throw statusFailure(response.status, upstream);
        const encoding = upstream.get("content-encoding");
        if (encoding !== null && encoding.trim().toLowerCase() !== "identity") {
          throw invalidResponse("The media server transformed the asset.");
        }
        declared = contentLengthValue(upstream.get("content-length"));
        if (declared !== undefined && declared > limit) {
          throw new MediaServerError("response-too-large", "The media server asset is too large.");
        }
        mediaType = assetContentType(upstream.get("content-type"));
        assetTypeAllowed(checked.kind, mediaType);
      } catch (error) {
        void response.body?.cancel().catch(() => undefined);
        throw error;
      }

      const bytes = await readAssetBytes(response, controller.signal, isTimedOut, limit);
      if (declared !== undefined && bytes.byteLength !== declared) {
        throw invalidResponse("The media server ended the asset early.");
      }

      let contentType: string;
      if (checked.kind === "artwork") {
        const detected = detectImageType(bytes);
        if (!detected) throw invalidResponse("The media server sent content that is not a supported image.");
        if (detected !== mediaType) throw invalidResponse("The media server image type does not match its content.");
        contentType = detected;
      } else {
        checkSubtitleText(bytes);
        contentType = "application/x-subrip";
      }
      return { bytes, contentType };
    } catch (error) {
      throw failure ?? mapTransportError(error, controller.signal, isTimedOut);
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", onAbort);
      active.delete(controller);
      controller.abort();
      if (agent) {
        agents.delete(agent);
        await agent.destroy().catch(() => undefined);
      }
    }
  }

  return {
    requestJson,
    requestOriginal,
    requestArtwork,
    requestAsset,
    async close() {
      closed = true;
      for (const controller of active) controller.abort();
      active.clear();
      for (const original of [...originals]) original.abort();
      for (const image of [...images]) image.abort();
      await Promise.all([...agents].map((agent) => agent.destroy().catch(() => undefined)));
    },
  };
}
