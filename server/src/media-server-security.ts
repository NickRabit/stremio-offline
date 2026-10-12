import nodeDns, { type LookupOptions } from "node:dns";
import net from "node:net";
import { Agent, fetch as undiciFetch } from "undici";
import {
  MediaServerError,
  MEDIA_SERVER_LIMITS,
  validateMediaServerToken,
} from "./media-server-types.js";

/** Requests the metadata transport is allowed to make, with the exact argument fields each
 *  one accepts. Anything else -- a raw path, a header, a stream or artwork URL -- is refused. */
export interface MediaServerOperationArgs {
  info: Record<string, never>;
  login: { username: string; password: string };
  user: { userId: string };
  views: { userId: string };
  items: { userId: string; parentId: string; includeItemTypes: string; startIndex?: number; limit?: number; searchTerm?: string };
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
  close(): Promise<void>;
}

export interface MediaServerTransportConfig extends MediaServerAddressPolicy {
  baseUrl: string;
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
}

const MAX_CONCURRENCY = 4;
const DEADLINE_MS = 10_000;
const MAX_RETRY_AFTER_MS = 300_000;
const CLIENT = "Stremio Offline";
const DEVICE = "Server";
const DEVICE_ID = "stremio-offline-server";
const CLIENT_VERSION = "1.0.0";
const ITEM_TYPES = new Set(["Movie", "Series", "Season", "Episode"]);

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

const itemTypes = (value: unknown): string => {
  if (typeof value !== "string" || value.length === 0 || value.length > 128) throw invalid("The media-server item types are missing.");
  const tokens = value.split(",");
  if (!tokens.length || tokens.some((token) => !ITEM_TYPES.has(token))) throw invalid("The media-server item types are not allowed.");
  return tokens.join(",");
};

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
      query.set("Fields", "ProviderIds,ParentId");
      query.set("EnableUserData", "false");
      query.set("ParentId", pathSegment(args.parentId, "parentId"));
      query.set("StartIndex", String(boundedIndex(args.startIndex, "startIndex", 1_000_000_000) ?? 0));
      query.set("Limit", String(pageLimit(args.limit)));
      const search = searchTerm(args.searchTerm);
      if (search !== undefined) query.set("SearchTerm", search);
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

  const literalHost = new URL(baseUrl).hostname.replace(/^\[|\]$/g, "");
  if (net.isIP(literalHost)) assertMediaServerAddress(literalHost, policy);

  const active = new Set<AbortController>();
  const agents = new Set<Agent>();
  let closed = false;

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
        authorization: `MediaBrowser Client="${CLIENT}", Device="${DEVICE}", DeviceId="${DEVICE_ID}", Version="${CLIENT_VERSION}"`,
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
        response = await guard(sendFetch(built.url, { ...init, signal: controller.signal }), controller.signal, isTimedOut);
      } catch (error) {
        throw mapTransportError(error, controller.signal, isTimedOut);
      }
      if (!response.ok) {
        void response.body?.cancel().catch(() => undefined);
        throw statusError(response.status, new Headers(response.headers));
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

  return {
    requestJson,
    async close() {
      closed = true;
      for (const controller of active) controller.abort();
      active.clear();
      await Promise.all([...agents].map((agent) => agent.destroy().catch(() => undefined)));
    },
  };
}
