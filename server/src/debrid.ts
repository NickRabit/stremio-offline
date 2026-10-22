import { log } from "./logger.js";
import { guardedFetch } from "./outbound.js";

export const RD_API = "https://api.real-debrid.com/rest/1.0";
export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export class DebridError extends Error {
  readonly status: number;
  readonly code?: string;
  constructor(message: string, status = 400, code?: string) {
    super(message);
    this.name = "DebridError";
    this.status = status;
    this.code = code;
  }
}

export function normalizeToken(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

const INFRINGING = new Set(["infringing_file", "virus_file"]);
/** Real-Debrid answers its API in seconds; one that has not after this is treated like a
 *  dropped connection and retried, rather than holding a check or a download for undici's
 *  five-minute default. */
const RD_TIMEOUT_MS = 30_000;

const FATAL = new Set([...INFRINGING, "bad_token", "expired_token", "account_blocked", "need_premium", "traffic_exhausted", "fair_usage_limit"]);

const rdError = (status: number, code?: string, errorCode?: number) => {
  if (status === 401 || code === "bad_token" || errorCode === 8) return new DebridError("The Real-Debrid token is not valid.", 401, code ?? "bad_token");
  if (status === 403 && code !== "traffic_exhausted") return new DebridError("Real-Debrid did not let this account use the API.", 403, code);
  if (INFRINGING.has(code ?? "") || errorCode === 16) {
    return new DebridError("Real-Debrid refused this torrent.", 451, "infringing_file");
  }
  if (code === "traffic_exhausted" || errorCode === 29) return new DebridError("The Real-Debrid account is out of traffic.", 403, "traffic_exhausted");
  if (code === "too_many_torrents" || errorCode === 21) {
    return new DebridError("The Real-Debrid account holds too many torrents. Delete some at real-debrid.com/torrents.", 400, code);
  }
  if (status === 429 || status === 509 || code === "too_many_active_downloads" || errorCode === 26) {
    return new DebridError("Real-Debrid has no free slot, trying again.", status === 429 ? 429 : 509, code);
  }
  if (status === 503 || status === 408 || code === "service_unavailable") {
    return new DebridError("Real-Debrid is not answering right now, trying again.", status === 408 ? 408 : 503, code ?? "service_unavailable");
  }
  return new DebridError(code ? `Real-Debrid: ${code}` : `Real-Debrid answered with an error (${status}).`, status, code);
};

export function isRetryableDebridFailure(error: unknown): boolean {
  if (error instanceof DebridError) return !FATAL.has(error.code ?? "") && (error.status === 408 || error.status === 429 || error.status === 503 || error.status === 509);
  const message = error instanceof Error ? error.message : String(error);
  return /fetch failed|ECONNRESET|ETIMEDOUT|ENOTFOUND|UND_ERR|not answering right now|no free slot/i.test(message);
}

async function readJson<T>(response: Response, path: string): Promise<T> {
  try {
    return await response.json() as T;
  } catch (error) {
    if (error instanceof SyntaxError) throw error;
    log("WARN", "Real-Debrid response body failed", { path, reason: error instanceof Error ? error.message : String(error) });
    throw new DebridError("Real-Debrid is not answering right now, trying again.", 408, "network");
  }
}

async function rdRequest(token: string, path: string, body?: Record<string, string>, fetchImpl: FetchLike = guardedFetch): Promise<Response> {
  const init: RequestInit = {
    method: body ? "POST" : "GET",
    headers: { authorization: `Bearer ${token}`, ...(body ? { "content-type": "application/x-www-form-urlencoded" } : {}) },
    body: body ? new URLSearchParams(body).toString() : undefined,
    signal: AbortSignal.timeout(RD_TIMEOUT_MS),
  };
  let response: Response;
  try {
    response = await fetchImpl(`${RD_API}${path}`, init);
  } catch (error) {
    log("WARN", "Real-Debrid request failed", { path, reason: error instanceof Error ? error.message : String(error) });
    throw new DebridError("Real-Debrid is not answering right now, trying again.", 408, "network");
  }
  if (response.ok) return response;
  let code: string | undefined;
  let errorCode: number | undefined;
  try {
    const payload = await readJson<{ error?: string; error_code?: number }>(response, path);
    code = typeof payload.error === "string" ? payload.error : undefined;
    errorCode = Number.isFinite(payload.error_code) ? Number(payload.error_code) : undefined;
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    /* Real-Debrid sometimes answers with an empty or malformed body. */
  }
  log("WARN", "Real-Debrid request failed", { path, status: response.status, code, errorCode });
  throw rdError(response.status, code, errorCode);
}

export interface DebridUser { username: string; premium: boolean }

export async function verifyRealDebridToken(token: string, fetchImpl: FetchLike = guardedFetch): Promise<DebridUser> {
  const value = normalizeToken(token);
  if (!value) throw new DebridError("Enter the Real-Debrid API token.");
  const response = await rdRequest(value, "/user", undefined, fetchImpl);
  const body = await readJson<{ username?: string; type?: string; premium?: number }>(response, "/user");
  const premium = body.type === "premium" || Number(body.premium) > 0;
  if (!premium) throw new DebridError("The Real-Debrid account is not premium.");
  return { username: String(body.username ?? ""), premium };
}

const INFO_HASH = /^(?:[a-f0-9]{40}|[a-z2-7]{32})$/i;
const VIDEO_EXT = /\.(mkv|mp4|avi|m4v|mov|wmv|ts|m2ts|webm|mpg|mpeg|iso)$/i;
const FAILED = new Set(["error", "virus", "dead", "magnet_error"]);

export function magnetFromHash(infoHash: string): string {
  const hash = infoHash.trim().toLowerCase();
  if (!INFO_HASH.test(hash)) throw new DebridError("The torrent has no valid infoHash.");
  return `magnet:?xt=urn:btih:${hash}`;
}

export interface DebridFile { id: number; path: string; bytes: number; selected: number }
export interface DebridTorrent {
  id: string;
  filename?: string;
  status: string;
  progress?: number;
  files?: DebridFile[];
  links?: string[];
}
export interface UnrestrictedLink { download: string; filename?: string; filesize?: number }

export async function addMagnet(token: string, magnet: string, fetchImpl: FetchLike = guardedFetch): Promise<string> {
  const response = await rdRequest(token, "/torrents/addMagnet", { magnet }, fetchImpl);
  const body = await readJson<{ id?: string }>(response, "/torrents/addMagnet");
  if (!body.id) throw new DebridError("Real-Debrid returned no torrent id.");
  return body.id;
}

export async function selectFiles(token: string, torrentId: string, files: string, fetchImpl: FetchLike = guardedFetch): Promise<void> {
  await rdRequest(token, `/torrents/selectFiles/${encodeURIComponent(torrentId)}`, { files }, fetchImpl);
}

export async function torrentInfo(token: string, torrentId: string, fetchImpl: FetchLike = guardedFetch): Promise<DebridTorrent> {
  const path = `/torrents/info/${encodeURIComponent(torrentId)}`;
  const response = await rdRequest(token, path, undefined, fetchImpl);
  return await readJson<DebridTorrent>(response, path);
}

export async function unrestrictLink(token: string, link: string, fetchImpl: FetchLike = guardedFetch): Promise<UnrestrictedLink> {
  const response = await rdRequest(token, "/unrestrict/link", { link }, fetchImpl);
  const body = await readJson<UnrestrictedLink>(response, "/unrestrict/link");
  if (!body.download) throw new DebridError("Real-Debrid returned no downloadable address.");
  return body;
}

export function videoFileIds(files: DebridFile[] | undefined, fileIdx?: number): string {
  const list = files ?? [];
  if (fileIdx != null && list[fileIdx]) return String(list[fileIdx].id);
  if (fileIdx != null) {
    const byId = list.find((file) => file.id === fileIdx + 1);
    if (byId) return String(byId.id);
  }
  const videos = list.filter((file) => VIDEO_EXT.test(file.path));
  if (videos.length) return videos.map((file) => file.id).join(",");
  if (list.length) return list.map((file) => file.id).join(",");
  return "all";
}

export function linkForFile(info: DebridTorrent, fileIdx?: number): string {
  const links = (info.links ?? []).filter(Boolean);
  if (!links.length) throw new DebridError("The Real-Debrid torrent has no link.");
  const selected = (info.files ?? []).filter((file) => file.selected);
  if (fileIdx != null) {
    const wanted = (info.files ?? [])[fileIdx] ?? (info.files ?? []).find((file) => file.id === fileIdx + 1);
    if (wanted) {
      const index = selected.findIndex((file) => file.id === wanted.id);
      if (index >= 0 && links[index]) return links[index];
    }
  }
  if (selected.length === links.length) {
    let best = 0;
    for (let index = 1; index < selected.length; index += 1) if (selected[index].bytes > selected[best].bytes) best = index;
    return links[best] ?? links[0];
  }
  return links[0];
}

export type DebridAdvance =
  | { ready: true; url: string; filename?: string; torrentId: string }
  | { ready: false; torrentId: string; progress?: number; status: string };

export async function advanceTorrent(
  token: string,
  infoHash: string,
  fileIdx: number | undefined,
  torrentId: string | undefined,
  fetchImpl: FetchLike = guardedFetch,
): Promise<DebridAdvance> {
  let id = torrentId;
  if (!id) id = await addMagnet(token, magnetFromHash(infoHash), fetchImpl);

  let info = await torrentInfo(token, id, fetchImpl);
  if (FAILED.has(info.status)) throw new DebridError("Real-Debrid torrent selhal.", 400, info.status);

  // Real-Debrid accepts a file selection only once it has pulled the magnet's
  // metadata. While the status is `magnet_conversion` the file list is still
  // empty and selectFiles answers 404 parameter_missing, so the selection has
  // to wait for a later poll — which is also why it lives here and not behind
  // the `!torrentId` branch above.
  if (info.status === "waiting_files_selection" && info.files?.length) {
    await selectFiles(token, id, videoFileIds(info.files, fileIdx), fetchImpl);
    info = await torrentInfo(token, id, fetchImpl);
    if (FAILED.has(info.status)) throw new DebridError("Real-Debrid torrent selhal.", 400, info.status);
  }
  if (info.status === "downloaded" && info.links?.length) {
    const unrestricted = await unrestrictLink(token, linkForFile(info, fileIdx), fetchImpl);
    return { ready: true, url: unrestricted.download, filename: unrestricted.filename, torrentId: id };
  }
  return { ready: false, torrentId: id, progress: Number(info.progress) || 0, status: info.status };
}

/** Instant play/inspect: only when Real-Debrid already has the file. */
export async function resolveIfReady(
  token: string,
  infoHash: string,
  fileIdx: number | undefined,
  fetchImpl: FetchLike = guardedFetch,
): Promise<UnrestrictedLink | undefined> {
  const step = await advanceTorrent(token, infoHash, fileIdx, undefined, fetchImpl);
  if (!step.ready) return undefined;
  return { download: step.url, filename: step.filename };
}
