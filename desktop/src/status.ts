import { httpAllowed, isAccessSignInUrl, parseServerOrigin } from "./origin.js";

export interface StatusInfo {
  version: string;
  restricted: boolean;
  secure: boolean;
}

export type ProbeFailure = "invalid" | "insecure-transport" | "unreachable" | "not-status" | "access-required";

export type ProbeResult =
  | { ok: true; version: string; restricted: boolean; secure: boolean }
  | { ok: false; reason: ProbeFailure };

/** The part of fetch the probe needs; global fetch and sessionFetch both fit. */
export type StatusFetch = (url: string, init: { redirect: "manual"; signal: AbortSignal }) => Promise<Response>;

export function readStatus(body: unknown): StatusInfo | null {
  if (typeof body !== "object" || body === null) return null;
  const record = body as Record<string, unknown>;
  if (record.status !== "ok") return null;
  if (typeof record.version !== "string" || !record.version) return null;
  if (typeof record.restricted !== "boolean") return null;
  if (typeof record.secure !== "boolean") return null;
  return { version: record.version, restricted: record.restricted, secure: record.secure };
}

/** Cloudflare Access answers an unauthenticated request with a redirect to its
 *  sign-in page, or a 401 carrying its own www-authenticate scheme. */
export function accessChallenge(response: Response): boolean {
  if (response.status >= 300 && response.status <= 399) {
    const location = response.headers.get("location");
    return location !== null && isAccessSignInUrl(location);
  }
  if (response.status !== 200) {
    const header = response.headers.get("www-authenticate")?.trim().toLowerCase() ?? "";
    return header.startsWith("cloudflare-access");
  }
  return false;
}

export async function fetchStatus(input: string, fetchImpl: StatusFetch = fetch, timeoutMs = 5000): Promise<ProbeResult> {
  const server = parseServerOrigin(input);
  if (!server) return { ok: false, reason: "invalid" };
  if (!httpAllowed(server)) return { ok: false, reason: "insecure-transport" };
  let response: Response;
  try {
    response = await fetchImpl(server.origin + "/api/status", { redirect: "manual", signal: AbortSignal.timeout(timeoutMs) });
  } catch {
    return { ok: false, reason: "unreachable" };
  }
  if (response.status !== 200) {
    return { ok: false, reason: accessChallenge(response) ? "access-required" : "not-status" };
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return { ok: false, reason: "not-status" };
  }
  const info = readStatus(body);
  if (!info) return { ok: false, reason: "not-status" };
  return { ok: true, ...info };
}
