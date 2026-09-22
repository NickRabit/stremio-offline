import { httpAllowed, parseServerOrigin } from "./origin.js";

export interface StatusInfo {
  version: string;
  restricted: boolean;
  secure: boolean;
}

export type ProbeFailure = "invalid" | "insecure-transport" | "unreachable" | "not-status";

export type ProbeResult =
  | { ok: true; version: string; restricted: boolean; secure: boolean }
  | { ok: false; reason: ProbeFailure };

export function readStatus(body: unknown): StatusInfo | null {
  if (typeof body !== "object" || body === null) return null;
  const record = body as Record<string, unknown>;
  if (record.status !== "ok") return null;
  if (typeof record.version !== "string" || !record.version) return null;
  if (typeof record.restricted !== "boolean") return null;
  if (typeof record.secure !== "boolean") return null;
  return { version: record.version, restricted: record.restricted, secure: record.secure };
}

export async function fetchStatus(input: string, fetchImpl: typeof fetch = fetch): Promise<ProbeResult> {
  const server = parseServerOrigin(input);
  if (!server) return { ok: false, reason: "invalid" };
  if (!httpAllowed(server)) return { ok: false, reason: "insecure-transport" };
  let response: Response;
  try {
    response = await fetchImpl(server.origin + "/api/status", { redirect: "manual", signal: AbortSignal.timeout(5000) });
  } catch {
    return { ok: false, reason: "unreachable" };
  }
  if (response.status !== 200) return { ok: false, reason: "not-status" };
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
