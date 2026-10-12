/**
 * Read-only media-server provider spike for Jellyfin and Emby (MS-0). It speaks
 * only the allowlisted read API below and refuses to build any other request.
 * Developer tool for synthetic loopback Docker servers; credentials come from
 * the environment or runSpike arguments. Node built-ins only. See
 * docs/media-server-libraries-{spec,analysis,tasks}.md.
 */
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

export const PROVIDERS = ["jellyfin", "emby"];

const MB_CLIENT = "Stremio Offline Spike";
const MB_DEVICE = "spike";
const MB_DEVICE_ID = "stremio-offline-spike";
const MB_VERSION = "0.1.0";

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_JSON_BYTES = 1024 * 1024;
const DEFAULT_MAX_BODY_BYTES = 4 * 1024 * 1024;

/** The spike compares two 32-byte ranges, so a useful fixture is at least 64 bytes. */
const RANGE_SIZE = 32;
const MIN_FIXTURE_BYTES = RANGE_SIZE * 2;
const SUBTITLE_CAP_BYTES = 256 * 1024;

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

const USAGE = `Read-only Jellyfin/Emby provider spike.

Usage:
  node scripts/media-server-spike.mjs --provider <jellyfin|emby> --url <origin>
      --item-id <id> --fixture <path> [--subtitle-index <n>] [--base-path <path>]

Options:
  --provider        jellyfin or emby
  --url             loopback origin, e.g. http://localhost:8096 (or :8920)
  --item-id         remote item id to read
  --fixture         local file whose bytes the original stream must return
  --subtitle-index  optional external subtitle stream index to fetch
  --base-path       optional reverse-proxy base path, e.g. /jellyfin
  --help            print this text

Credentials are read from MEDIA_SERVER_USERNAME and MEDIA_SERVER_PASSWORD only.
`;

export class SpikeError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "SpikeError";
    this.code = code;
  }
}

const asString = (value) => (typeof value === "string" && value.length > 0 ? value : undefined);

function parseLoopbackUrl(raw, label = "url") {
  if (typeof raw !== "string" || raw.trim() === "") throw new SpikeError("invalid-origin", `${label} is required`);
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new SpikeError("invalid-origin", `${label} is not a valid URL`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new SpikeError("invalid-origin", `${label} must use http or https`);
  }
  if (url.username || url.password) throw new SpikeError("invalid-origin", `${label} must not carry credentials`);
  if (url.search) throw new SpikeError("invalid-origin", `${label} must not carry a query`);
  if (url.hash) throw new SpikeError("invalid-origin", `${label} must not carry a fragment`);
  if (!LOOPBACK_HOSTS.has(url.hostname)) {
    throw new SpikeError("non-loopback-origin", `${label} must point at localhost, 127.0.0.1 or [::1]`);
  }
  return url;
}

function normalizeBasePath(input) {
  if (input === undefined || input === null || input === "" || input === "/") return "";
  if (typeof input !== "string") throw new SpikeError("invalid-base-path", "base path must be a string");
  if (/[?#]/.test(input)) throw new SpikeError("invalid-base-path", "base path must not carry a query or fragment");
  const raw = input.startsWith("/") ? input : `/${input}`;
  const segments = raw.split("/").filter((segment) => segment !== "");
  for (const segment of segments) {
    let decoded;
    try {
      decoded = decodeURIComponent(segment);
    } catch {
      throw new SpikeError("invalid-base-path", "base path contains invalid percent-encoding");
    }
    if (decoded === "." || decoded === ".." || decoded.includes("/") || decoded.includes("\\")) {
      throw new SpikeError("invalid-base-path", "base path must not escape its prefix");
    }
  }
  return segments.length === 0 ? "" : `/${segments.join("/")}`;
}

function decodeSegments(pathname) {
  if (typeof pathname !== "string" || !pathname.startsWith("/")) {
    throw new SpikeError("invalid-path", "path must be an absolute request path");
  }
  // The pathname is concatenated into the request URL, so a raw query, fragment
  // or backslash would let a matched rule address a URL other than the one it
  // matched against.
  if (/[?#\\]/.test(pathname)) {
    throw new SpikeError("invalid-path", "path must not contain a raw query, fragment or backslash");
  }
  const segments = pathname.split("/").slice(1);
  if (segments.length === 0 || segments.some((segment) => segment === "")) {
    throw new SpikeError("invalid-path", "path must not contain empty segments");
  }
  return segments.map((segment) => {
    let decoded;
    try {
      decoded = decodeURIComponent(segment);
    } catch {
      throw new SpikeError("invalid-path", "path segment is not valid percent-encoding");
    }
    if (decoded === "." || decoded === ".." || decoded.includes("/") || decoded.includes("\\")) {
      throw new SpikeError("path-escape", "path segment must not escape its position");
    }
    return decoded;
  });
}

const param = (name) => ({ param: name });

/** The exact allowlist; `query` is the only set of query keys a rule may carry. */
const ALLOWLIST = [
  { methods: ["GET"], segments: ["System", "Info", "Public"], query: [], label: "GET /System/Info/Public" },
  {
    methods: ["POST"],
    segments: ["Users", "AuthenticateByName"],
    query: [],
    allowBody: true,
    label: "POST /Users/AuthenticateByName",
  },
  { methods: ["GET"], segments: ["Users", param("userId"), "Views"], query: [], label: "GET /Users/{userId}/Views" },
  {
    methods: ["GET"],
    segments: ["Users", param("userId"), "Items"],
    query: ["ParentId", "Recursive", "IncludeItemTypes", "Fields", "StartIndex", "Limit", "EnableUserData"],
    label: "GET /Users/{userId}/Items",
  },
  {
    methods: ["GET"],
    segments: ["Users", param("userId"), "Items", param("itemId")],
    query: [],
    label: "GET /Users/{userId}/Items/{itemId}",
  },
  {
    methods: ["GET"],
    segments: ["Items", param("itemId"), "PlaybackInfo"],
    query: ["UserId"],
    label: "GET /Items/{itemId}/PlaybackInfo",
  },
  {
    methods: ["HEAD", "GET"],
    segments: ["Videos", param("itemId"), "stream"],
    query: ["Static", "MediaSourceId"],
    requiredQuery: ["Static", "MediaSourceId"],
    label: "HEAD/GET /Videos/{itemId}/stream",
  },
  {
    methods: ["GET"],
    segments: ["Videos", param("itemId"), param("sourceId"), "Subtitles", param("index"), "Stream.srt"],
    query: [],
    label: "GET /Videos/{itemId}/{sourceId}/Subtitles/{index}/Stream.srt",
  },
  { methods: ["GET"], segments: ["Sessions"], query: [], label: "GET /Sessions" },
];

function matchRule(method, segments) {
  for (const rule of ALLOWLIST) {
    if (!rule.methods.includes(method)) continue;
    if (rule.segments.length !== segments.length) continue;
    let matches = true;
    for (let index = 0; index < segments.length; index += 1) {
      const slot = rule.segments[index];
      if (typeof slot === "string" ? slot !== segments[index] : segments[index] === "") {
        matches = false;
        break;
      }
    }
    if (matches) return rule;
  }
  return undefined;
}

function buildParams(rule, query) {
  const params = new URLSearchParams();
  const entries =
    query === undefined || query === null
      ? []
      : query instanceof URLSearchParams
        ? [...query.entries()]
        : Object.entries(query);
  for (const [key, value] of entries) {
    if (value === undefined || value === null) continue;
    if (!rule.query.includes(key)) {
      throw new SpikeError("query-not-allowed", `query parameter ${key} is not allowed for ${rule.label}`);
    }
    const text = String(value);
    if (key === "Static" && text !== "true") throw new SpikeError("query-not-allowed", "Static must be true");
    if (key === "MediaSourceId" && text === "") {
      throw new SpikeError("query-not-allowed", "MediaSourceId must not be empty");
    }
    params.append(key, text);
  }
  for (const key of rule.requiredQuery ?? []) {
    if (!params.has(key)) {
      throw new SpikeError("query-not-allowed", `${rule.label} requires query parameter ${key}`);
    }
  }
  return params;
}

const isTimeout = (error) => error?.name === "TimeoutError" || error?.cause?.name === "TimeoutError";

function requestSignal(timeoutMs, extra) {
  const timeout = AbortSignal.timeout(timeoutMs);
  return extra ? AbortSignal.any([timeout, extra]) : timeout;
}

async function readBounded(res, cap, label) {
  if (!res.body) return new Uint8Array(0);
  const reader = res.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > cap) {
        try {
          await reader.cancel();
        } catch {
          /* the cap already failed the read */
        }
        throw new SpikeError("body-too-large", `${label} exceeded the ${cap}-byte response cap`);
      }
      chunks.push(value);
    }
  } catch (error) {
    if (isTimeout(error)) throw new SpikeError("timeout", `${label} timed out while reading the response`);
    throw error;
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

async function readJson(res, cap, label) {
  const bytes = await readBounded(res, cap, label);
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new SpikeError("invalid-json", `${label} did not return JSON`);
  }
}

/**
 * The token is inlined into a quoted MediaBrowser header value, so a quote,
 * backslash or control character could break out of it. Providers never issue
 * such tokens.
 */
function validateToken(value) {
  if (typeof value !== "string" || value.length === 0) {
    throw new SpikeError("invalid-token", "token must be a non-empty string");
  }
  if (/[\u0000-\u001f\u007f"\\]/.test(value)) {
    throw new SpikeError("invalid-token", "token must not contain quotes, backslashes or control characters");
  }
  return value;
}

const mediabrowserHeader = (token) => {
  const fields = [
    `Client="${MB_CLIENT}"`,
    `Device="${MB_DEVICE}"`,
    `DeviceId="${MB_DEVICE_ID}"`,
    `Version="${MB_VERSION}"`,
  ];
  if (token) fields.push(`Token="${token}"`);
  return `MediaBrowser ${fields.join(", ")}`;
};

const encode = (value) => encodeURIComponent(String(value));

/** Client bound to one loopback origin and base path; every request is allowlisted before fetch. */
export function createReadOnlyClient(options = {}) {
  const originUrl = parseLoopbackUrl(options.origin ?? options.url, "origin");
  const origin = originUrl.origin;
  const explicitBase = normalizeBasePath(options.basePath);
  const urlBase = normalizeBasePath(originUrl.pathname);
  if (explicitBase && urlBase && explicitBase !== urlBase) {
    throw new SpikeError("conflicting-base-path", `origin path ${urlBase} does not match basePath ${explicitBase}`);
  }
  const basePath = explicitBase || urlBase;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxJsonBytes = options.maxJsonBytes ?? DEFAULT_MAX_JSON_BYTES;
  const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== "function") throw new SpikeError("no-fetch", "a fetch implementation is required");
  let currentToken = options.token === undefined || options.token === null ? undefined : validateToken(options.token);
  const trace = [];

  async function request(method, pathname, opts = {}) {
    const upper = String(method ?? "").toUpperCase();
    const segments = decodeSegments(pathname);
    const rule = matchRule(upper, segments);
    if (!rule) throw new SpikeError("path-not-allowed", `${upper} ${pathname} is not in the read-only allowlist`);
    const params = buildParams(rule, opts.query);
    if (opts.body !== undefined && rule.allowBody !== true) {
      throw new SpikeError("body-not-allowed", `${upper} ${pathname} must not carry a request body`);
    }
    if (rule.allowBody === true && opts.body === undefined) {
      throw new SpikeError("body-required", `${upper} ${pathname} requires a request body`);
    }
    const search = params.toString();
    const url = new URL(`${origin}${basePath}${pathname}${search ? `?${search}` : ""}`);
    const queryKeys = [...params.keys()];
    if (url.origin !== origin) throw new SpikeError("cross-origin", "request destination left the configured origin");
    if (url.username || url.password || url.hash) {
      throw new SpikeError("invalid-destination", "request destination must not carry credentials or a fragment");
    }
    if (basePath && url.pathname !== basePath && !url.pathname.startsWith(`${basePath}/`)) {
      throw new SpikeError("path-escape", "request destination escaped the configured base path");
    }
    const headers = { Accept: "application/json", Authorization: mediabrowserHeader(currentToken) };
    if (currentToken) headers["X-Emby-Token"] = currentToken;
    if (opts.body !== undefined) headers["Content-Type"] = "application/json";
    if (opts.headers) Object.assign(headers, opts.headers);

    let res;
    try {
      res = await fetchImpl(url, {
        method: upper,
        headers,
        body: opts.body,
        redirect: "error",
        signal: requestSignal(timeoutMs, opts.signal),
      });
    } catch (error) {
      const code = isTimeout(error) ? "timeout" : "request-failed";
      trace.push({ method: upper, path: url.pathname, queryKeys, status: null, error: code });
      throw new SpikeError(code, `${upper} ${url.pathname} failed without a response`);
    }
    trace.push({ method: upper, path: url.pathname, queryKeys, status: res.status });
    const label = `${upper} ${url.pathname}`;
    if (!res.ok) {
      try {
        await res.body?.cancel();
      } catch {
        /* the status is the whole error */
      }
    }
    return {
      status: res.status,
      ok: res.ok,
      headers: res.headers,
      json: () => readJson(res, maxJsonBytes, label),
      bytes: (limit = maxBodyBytes) => readBounded(res, limit, label),
    };
  }

  return {
    origin,
    basePath,
    trace,
    hasToken: () => Boolean(currentToken),
    /** Replaces the token after authentication. The value never enters the trace. */
    setToken(next) {
      currentToken = validateToken(next);
    },
    request,
    systemInfo: () => request("GET", "/System/Info/Public"),
    authenticate: (username, password) =>
      request("POST", "/Users/AuthenticateByName", {
        body: JSON.stringify({ Username: username, Pw: password }),
      }),
    views: (userId) => request("GET", `/Users/${encode(userId)}/Views`),
    item: (userId, itemId) => request("GET", `/Users/${encode(userId)}/Items/${encode(itemId)}`),
    playbackInfo: (itemId, userId) =>
      request("GET", `/Items/${encode(itemId)}/PlaybackInfo`, { query: { UserId: userId } }),
    headStream: (itemId, mediaSourceId) =>
      request("HEAD", `/Videos/${encode(itemId)}/stream`, {
        query: { Static: "true", MediaSourceId: mediaSourceId },
      }),
    getStreamRange: (itemId, mediaSourceId, range) =>
      request("GET", `/Videos/${encode(itemId)}/stream`, {
        query: { Static: "true", MediaSourceId: mediaSourceId },
        headers: { Range: `bytes=${range}` },
      }),
    subtitle: (itemId, sourceId, index) =>
      request("GET", `/Videos/${encode(itemId)}/${encode(sourceId)}/Subtitles/${encode(index)}/Stream.srt`),
    sessions: () => request("GET", "/Sessions"),
  };
}

const USER_DATA_KEYS = ["PlaybackPositionTicks", "Played", "PlayCount", "LastPlayedDate", "IsFavorite"];

const isNumber = (value) => typeof value === "number" && Number.isFinite(value);

/** Absent and default transport values compare equal: null ticks is zero, null date is none. */
function normalizeUserData(userData) {
  const data = userData && typeof userData === "object" ? userData : {};
  return {
    PlaybackPositionTicks: isNumber(data.PlaybackPositionTicks) ? data.PlaybackPositionTicks : 0,
    Played: data.Played === true,
    PlayCount: isNumber(data.PlayCount) ? data.PlayCount : 0,
    LastPlayedDate: asString(data.LastPlayedDate) ?? null,
    IsFavorite: data.IsFavorite === true,
  };
}

function userDataDiff(before, after) {
  return USER_DATA_KEYS.filter((key) => before[key] !== after[key]);
}

/** Live TV, remote mounts and HLS playlists are not an original file our proxy can read. */
function isLiveOrRemoteSource(source) {
  if (!source || typeof source !== "object") return true;
  if (source.Protocol !== "File" || source.IsInfiniteStream || source.RequiresOpening || source.RequiresClosing) return true;
  if (source.IsRemote === true) return true;
  if (asString(source.LiveStreamId)) return true;
  const haystack = [source.Protocol, source.Container, source.Path]
    .filter((value) => typeof value === "string")
    .join(" ")
    .toLowerCase();
  return haystack.includes("hls") || haystack.includes(".m3u8");
}

function parseContentRange(value) {
  const match = /^bytes (\d+)-(\d+)\/(\d+|\*)$/.exec(String(value ?? "").trim());
  if (!match) return undefined;
  return { start: Number(match[1]), end: Number(match[2]), total: match[3] === "*" ? undefined : Number(match[3]) };
}

const bytesEqual = (a, b) => a.byteLength === b.byteLength && a.every((byte, index) => byte === b[index]);

const check = (id, status, detail, required) => ({ id, status, detail, required });

const describeError = (error) =>
  error instanceof SpikeError ? `${error.code}: ${error.message}` : `${error?.name ?? "Error"}: ${error?.message ?? String(error)}`;

/** Runs the spike and returns the report; required checks that do not pass make `ok` false. */
export async function runSpike(options = {}) {
  const provider = options.provider;
  if (!PROVIDERS.includes(provider)) {
    throw new SpikeError("invalid-provider", `provider must be one of ${PROVIDERS.join(", ")}`);
  }
  const origin = options.url ?? options.origin;
  const itemId = options.itemId;
  if (typeof itemId !== "string" || itemId === "") throw new SpikeError("invalid-item-id", "itemId is required");
  const fixturePath = options.fixturePath ?? options.fixture;
  if (typeof fixturePath !== "string" || fixturePath === "") {
    throw new SpikeError("invalid-fixture", "fixturePath is required");
  }
  let fixture;
  try {
    fixture = await readFile(fixturePath);
  } catch (error) {
    throw new SpikeError("invalid-fixture", `fixture ${fixturePath} could not be read: ${error?.code ?? error?.name}`);
  }
  if (fixture.byteLength < MIN_FIXTURE_BYTES) {
    throw new SpikeError("invalid-fixture", `fixture must be at least ${MIN_FIXTURE_BYTES} bytes`);
  }
  const subtitleIndex = options.subtitleIndex === undefined ? undefined : Number(options.subtitleIndex);
  if (subtitleIndex !== undefined && !Number.isInteger(subtitleIndex)) {
    throw new SpikeError("invalid-subtitle-index", "subtitleIndex must be an integer");
  }
  const username = options.username ?? process.env.MEDIA_SERVER_USERNAME;
  const password = options.password ?? process.env.MEDIA_SERVER_PASSWORD;
  if (!asString(username) || typeof password !== "string" || password === "") {
    throw new SpikeError("missing-credentials", "MEDIA_SERVER_USERNAME and MEDIA_SERVER_PASSWORD must be set");
  }

  const client = createReadOnlyClient({
    origin,
    basePath: options.basePath,
    timeoutMs: options.timeoutMs,
    maxJsonBytes: options.maxJsonBytes,
    maxBodyBytes: options.maxBodyBytes,
    fetchImpl: options.fetchImpl,
  });

  const checks = [];
  const add = (id, status, detail, required = true) => checks.push(check(id, status, detail, required));
  let blocked = null;
  const describeBlock = () => (blocked ? `skipped: ${blocked}` : "");
  const skipIfBlocked = (id, required = true) => {
    if (!blocked) return false;
    add(id, "untested", describeBlock(), required);
    return true;
  };
  const fail = (id, error, required = true) => {
    add(id, "fail", describeError(error), required);
    blocked = `${id} failed`;
  };

  const result = {
    provider,
    origin: client.origin,
    basePath: client.basePath || null,
    version: null,
    serverId: null,
    serverName: null,
    item: { id: itemId, type: null },
    mediaSourceId: null,
    fixture: { path: fixturePath, bytes: fixture.byteLength },
    ranges: [],
    userData: null,
    sessions: null,
    subtitle: null,
    checks,
    trace: client.trace,
  };

  let publicInfo = null;
  if (!skipIfBlocked("server-info")) {
    try {
      const res = await client.systemInfo();
      if (!res.ok) throw new SpikeError("http-error", `GET /System/Info/Public answered ${res.status}`);
      publicInfo = await res.json();
      result.version = asString(publicInfo?.Version) ?? null;
      result.serverId = asString(publicInfo?.Id) ?? null;
      result.serverName = asString(publicInfo?.ServerName) ?? null;
      if (!result.version || !result.serverId) {
        throw new SpikeError("server-identity", "PublicSystemInfo did not report Version and Id");
      }
      add("server-info", "pass", `reported version ${result.version}; server id present`, true);
    } catch (error) {
      fail("server-info", error);
    }
  }

  let userId = null;
  if (!skipIfBlocked("authenticate")) {
    try {
      const res = await client.authenticate(username, password);
      if (!res.ok) throw new SpikeError("http-error", `POST /Users/AuthenticateByName answered ${res.status}`);
      const data = await res.json();
      const token = asString(data?.AccessToken);
      userId = asString(data?.User?.Id);
      if (!token || !userId) throw new SpikeError("authentication", "response carried no AccessToken or User.Id");
      client.setToken(token);
      add("authenticate", "pass", "token issued and account id resolved", true);
    } catch (error) {
      fail("authenticate", error);
    }
  }

  if (!skipIfBlocked("views")) {
    try {
      const res = await client.views(userId);
      if (!res.ok) throw new SpikeError("http-error", `GET /Users/{userId}/Views answered ${res.status}`);
      const data = await res.json();
      const views = data?.Items;
      if (!Array.isArray(views)) throw new SpikeError("views", "Views response carried no Items array");
      add("views", "pass", `${views.length} account-visible view(s)`, true);
    } catch (error) {
      fail("views", error);
    }
  }

  let userDataBefore = null;
  if (!skipIfBlocked("item-read")) {
    try {
      const res = await client.item(userId, itemId);
      if (!res.ok) throw new SpikeError("http-error", `GET /Users/{userId}/Items/{itemId} answered ${res.status}`);
      const data = await res.json();
      if (!data || typeof data !== "object") throw new SpikeError("item-read", "item response was not an object");
      result.item.type = asString(data.Type) ?? null;
      userDataBefore = normalizeUserData(data.UserData);
      add("item-read", "pass", `item read; user data captured (${result.item.type ?? "unknown type"})`, true);
    } catch (error) {
      fail("item-read", error);
    }
  }

  let mediaSources = null;
  if (!skipIfBlocked("playback-info")) {
    try {
      const res = await client.playbackInfo(itemId, userId);
      if (!res.ok) {
        const detail = `GET /Items/{itemId}/PlaybackInfo answered ${res.status}`;
        if (res.status === 404 || res.status === 405) {
          add(
            "playback-info",
            "unsupported",
            `${detail}; POST PlaybackInfo is deliberately not on the allowlist, so original-media preparation is UNSUPPORTED in this candidate`,
            true,
          );
        } else {
          add("playback-info", "fail", `http-error: ${detail}`, true);
        }
        blocked = "playback-info did not return media sources";
      } else {
        const data = await res.json();
        mediaSources = Array.isArray(data?.MediaSources) ? data.MediaSources : null;
        if (!mediaSources) throw new SpikeError("playback-info", "PlaybackInfo carried no MediaSources array");
        add("playback-info", "pass", `${mediaSources.length} media source(s) reported`, true);
      }
    } catch (error) {
      fail("playback-info", error);
    }
  }

  let selectedSource = null;
  if (!skipIfBlocked("media-source")) {
    const requested = asString(options.mediaSourceId);
    const candidates = mediaSources.filter((source) => !isLiveOrRemoteSource(source));
    const chosen = requested
      ? mediaSources.find((source) => source?.Id === requested)
      : candidates[0];
    if (requested && !chosen) {
      fail("media-source", new SpikeError("media-source", `requested media source ${requested} was not reported`));
    } else if (!chosen) {
      add(
        "media-source",
        "unsupported",
        "no media source outside live/remote/HLS was reported; the original-media endpoint is UNSUPPORTED for this item",
        true,
      );
      blocked = "no usable media source";
    } else if (isLiveOrRemoteSource(chosen)) {
      fail("media-source", new SpikeError("media-source", `selected media source ${chosen.Id ?? "(no id)"} is live/remote/HLS`));
    } else if (!asString(chosen.Id)) {
      fail("media-source", new SpikeError("media-source", "selected media source carries no Id"));
    } else {
      selectedSource = chosen;
      result.mediaSourceId = chosen.Id;
      add(
        "media-source",
        "pass",
        `selected source ${chosen.Id} (${mediaSources.length - candidates.length} live/remote/HLS source(s) skipped)`,
        true,
      );
    }
  }

  // Captured straight after preparation so a change the later byte reads undo is
  // still visible; the final snapshot alone would miss it.
  let userDataAfterPreparation = null;
  if (!skipIfBlocked("preparation-snapshot")) {
    try {
      const res = await client.item(userId, itemId);
      if (!res.ok) throw new SpikeError("http-error", `GET /Users/{userId}/Items/{itemId} answered ${res.status}`);
      const data = await res.json();
      userDataAfterPreparation = normalizeUserData(data?.UserData);
      add("preparation-snapshot", "pass", "user data re-read immediately after media-source selection", true);
    } catch (error) {
      fail("preparation-snapshot", error);
    }
  }

  let headLength = null;
  if (!skipIfBlocked("head-original")) {
    try {
      const res = await client.headStream(itemId, selectedSource.Id);
      if (res.status !== 200 && res.status !== 206) {
        throw new SpikeError("http-error", `HEAD /Videos/{itemId}/stream answered ${res.status}`);
      }
      const declared = res.headers.get("content-length");
      if (declared === null) {
        throw new SpikeError("head-length", "HEAD /Videos/{itemId}/stream answered without Content-Length");
      }
      headLength = Number(declared);
      if (!Number.isFinite(headLength) || headLength !== fixture.byteLength) {
        throw new SpikeError(
          "head-length",
          `HEAD reported Content-Length ${declared} but the fixture is ${fixture.byteLength} bytes`,
        );
      }
      add("head-original", "pass", `HEAD answered ${res.status} with Content-Length ${headLength}`, true);
    } catch (error) {
      fail("head-original", error);
    }
  }

  const ranges = [
    { id: "range-first", start: 0, end: RANGE_SIZE - 1 },
    { id: "range-second", start: RANGE_SIZE, end: RANGE_SIZE * 2 - 1 },
  ];
  const rangeBytes = [];
  for (const range of ranges) {
    if (skipIfBlocked(range.id)) continue;
    try {
      const res = await client.getStreamRange(itemId, selectedSource.Id, `${range.start}-${range.end}`);
      if (res.status !== 206) {
        throw new SpikeError("http-error", `Range bytes=${range.start}-${range.end} answered ${res.status}, not 206`);
      }
      const contentRange = parseContentRange(res.headers.get("content-range"));
      const totalMatches = contentRange && contentRange.total === fixture.byteLength;
      if (!contentRange || contentRange.start !== range.start || contentRange.end !== range.end || !totalMatches) {
        throw new SpikeError(
          "content-range",
          `Range bytes=${range.start}-${range.end} returned Content-Range ${
            res.headers.get("content-range") ?? "(none)"
          }, expected ${range.start}-${range.end}/${fixture.byteLength}`,
        );
      }
      const bytes = await res.bytes();
      rangeBytes.push(bytes);
      result.ranges.push({
        requested: `${range.start}-${range.end}`,
        status: res.status,
        contentRange: `${contentRange.start}-${contentRange.end}/${contentRange.total ?? "*"}`,
        bytes: bytes.byteLength,
      });
      add(range.id, "pass", `206 with Content-Range ${contentRange.start}-${contentRange.end}, ${bytes.byteLength} bytes`, true);
    } catch (error) {
      fail(range.id, error);
    }
  }

  if (!skipIfBlocked("stream-request-shape")) {
    const streamTrace = client.trace.filter((entry) => entry.path.endsWith("/stream"));
    const shaped = streamTrace.length >= 3
      && streamTrace.every((entry) => entry.queryKeys.includes("Static") && entry.queryKeys.includes("MediaSourceId"));
    if (!shaped) {
      fail(
        "stream-request-shape",
        new SpikeError("stream-request", "original-media requests must carry Static=true and MediaSourceId explicitly"),
      );
    } else {
      add("stream-request-shape", "pass", `${streamTrace.length} original-media request(s) sent Static=true and MediaSourceId`, true);
    }
  }

  if (!skipIfBlocked("fixture-bytes")) {
    if (rangeBytes.length !== ranges.length) {
      add("fixture-bytes", "untested", "skipped: a range read did not complete", true);
    } else if (
      bytesEqual(rangeBytes[0], fixture.subarray(0, RANGE_SIZE))
      && bytesEqual(rangeBytes[1], fixture.subarray(RANGE_SIZE, RANGE_SIZE * 2))
    ) {
      add("fixture-bytes", "pass", "both ranges matched the fixture bytes exactly", true);
    } else {
      add("fixture-bytes", "fail", "range bytes did not match the local fixture", true);
    }
  }

  if (!skipIfBlocked("sessions", false)) {
    try {
      const res = await client.sessions();
      if (!res.ok) {
        add("sessions", "untested", `GET /Sessions answered ${res.status}`, false);
      } else {
        const data = await res.json();
        const list = Array.isArray(data) ? data : Array.isArray(data?.Items) ? data.Items : null;
        if (!list) throw new SpikeError("sessions", "Sessions response was not an array");
        const playing = list.filter((session) => session?.NowPlayingItem?.Id === itemId);
        const transcoding = playing.filter((session) => Boolean(session?.TranscodingInfo));
        result.sessions = { count: list.length, playing: playing.length > 0, transcoding: transcoding.length > 0 };
        if (transcoding.length > 0) {
          add("sessions", "fail", "the fixture item is transcoding on the remote server; no remote transcode is allowed", false);
        } else if (playing.length > 0) {
          add("sessions", "fail", "the fixture item has an active remote session during a read-only spike", false);
        } else {
          add("sessions", "pass", `${list.length} session(s); fixture item neither playing nor transcoding`, false);
        }
      }
    } catch (error) {
      add("sessions", "untested", describeError(error), false);
    }
  }

  if (subtitleIndex === undefined) {
    add("subtitle", "untested", "no --subtitle-index given", false);
  } else if (!skipIfBlocked("subtitle", false)) {
    try {
      if (!selectedSource) throw new SpikeError("subtitle", "no media source selected for the subtitle path");
      const res = await client.subtitle(itemId, selectedSource.Id, subtitleIndex);
      if (res.status !== 200) throw new SpikeError("http-error", `subtitle fetch answered ${res.status}`);
      const bytes = await res.bytes(SUBTITLE_CAP_BYTES);
      const text = new TextDecoder().decode(bytes);
      const trimmed = text.trim();
      if (trimmed.length === 0) throw new SpikeError("subtitle", "subtitle body was empty");
      result.subtitle = { index: subtitleIndex, bytes: bytes.byteLength, hasTimingLine: trimmed.includes("-->") };
      add("subtitle", "pass", `subtitle ${subtitleIndex} returned ${bytes.byteLength} non-empty bytes`, false);
    } catch (error) {
      add("subtitle", "fail", describeError(error), false);
    }
  }

  // Final snapshot runs after every read, so a change caused by a subtitle or
  // session request is still caught even when the byte reads left history alone.
  if (!skipIfBlocked("history-isolation")) {
    try {
      const res = await client.item(userId, itemId);
      if (!res.ok) throw new SpikeError("http-error", `GET /Users/{userId}/Items/{itemId} answered ${res.status}`);
      const data = await res.json();
      const after = normalizeUserData(data?.UserData);
      result.userData = { before: userDataBefore, afterPreparation: userDataAfterPreparation, after };
      const preparationDiff = userDataDiff(userDataBefore, userDataAfterPreparation);
      const diff = userDataDiff(userDataBefore, after);
      if (diff.length > 0 || preparationDiff.length > 0) {
        const changed = [...new Set([...diff, ...preparationDiff])].join(", ");
        add("history-isolation", "fail", `remote user data changed during original-media preparation: ${changed}`, true);
      } else {
        add("history-isolation", "pass", `user data unchanged (${USER_DATA_KEYS.join(", ")})`, true);
      }
    } catch (error) {
      fail("history-isolation", error);
    }
  }

  add("cancellation", "untested", "interrupted-read cancellation is not exercised by this spike", false);

  const ok = checks.every((entry) => entry.status === "pass" || (entry.status === "untested" && !entry.required));
  return { ...result, ok };
}

export function parseArgs(argv) {
  const args = { help: false };
  const need = (index, flag) => {
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) throw new SpikeError("invalid-argument", `${flag} needs a value`);
    return value;
  };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    switch (flag) {
      case "--help":
      case "-h":
        args.help = true;
        break;
      case "--provider":
        args.provider = need(index, flag);
        index += 1;
        break;
      case "--url":
        args.url = need(index, flag);
        index += 1;
        break;
      case "--item-id":
        args.itemId = need(index, flag);
        index += 1;
        break;
      case "--fixture":
        args.fixturePath = need(index, flag);
        index += 1;
        break;
      case "--subtitle-index": {
        const value = Number(need(index, flag));
        if (!Number.isInteger(value)) throw new SpikeError("invalid-argument", "--subtitle-index needs an integer");
        args.subtitleIndex = value;
        index += 1;
        break;
      }
      case "--base-path":
        args.basePath = need(index, flag);
        index += 1;
        break;
      default:
        throw new SpikeError("invalid-argument", `unknown argument ${flag}`);
    }
  }
  return args;
}

export async function main(argv = process.argv.slice(2)) {
  let args;
  try {
    args = parseArgs(argv);
  } catch (error) {
    console.error(USAGE);
    console.error(describeError(error));
    return 2;
  }
  if (args.help) {
    console.log(USAGE);
    return 0;
  }
  for (const flag of ["provider", "url", "itemId", "fixturePath"]) {
    if (!args[flag]) {
      console.error(USAGE);
      console.error(`missing required --${flag.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}`);
      return 2;
    }
  }
  const username = process.env.MEDIA_SERVER_USERNAME;
  const password = process.env.MEDIA_SERVER_PASSWORD;
  if (!asString(username) || typeof password !== "string" || password === "") {
    console.error("MEDIA_SERVER_USERNAME and MEDIA_SERVER_PASSWORD must be set in the environment");
    return 2;
  }
  try {
    const report = await runSpike({ ...args, username, password });
    console.log(JSON.stringify(report, null, 2));
    return report.ok ? 0 : 1;
  } catch (error) {
    console.error(JSON.stringify({ error: { code: error?.code ?? "error", message: describeError(error) } }, null, 2));
    return 2;
  }
}

const isMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main()
    .then((code) => process.exit(code))
    .catch((error) => {
      console.error(`media-server-spike crashed: ${error?.name ?? "Error"}`);
      process.exit(2);
    });
}
