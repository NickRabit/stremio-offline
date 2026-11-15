import type { StatusFetch } from "./status.js";

/** The requests after which the page may be signed in as somebody else. `GET /api/auth/me` is
 *  deliberately absent: the lock's own probe asks it, and must not wake itself. */
const ACCOUNT_PATHS = new Set(["/api/auth/login", "/api/auth/logout", "/api/auth/setup", "/api/profiles/switch"]);

/** URL filters for `webRequest.onCompleted`; the origin is compared when the request arrives. */
export const ACCOUNT_REQUEST_FILTERS = [...ACCOUNT_PATHS].map((path) => `*://*${path}`);

export function accountMayHaveChanged(url: string, origin: string | null): boolean {
  if (!origin) return false;
  try {
    const parsed = new URL(url);
    return parsed.origin === origin && ACCOUNT_PATHS.has(parsed.pathname);
  } catch {
    return false;
  }
}

/**
 * Whether the account signed in on this server's page is a child account. The shell asks the
 * server itself, through the page's own session, rather than believing the page. `undefined`
 * means the answer could not be read: the caller keeps what it knew.
 */
export async function readChildAccount(origin: string, fetchImpl: StatusFetch, timeoutMs = 5000): Promise<boolean | undefined> {
  try {
    const response = await fetchImpl(`${origin}/api/auth/me`, { redirect: "manual", signal: AbortSignal.timeout(timeoutMs) });
    // Nobody is signed in: there is no child to hold in.
    if (response.status === 401) return false;
    if (!response.ok) return undefined;
    const body: unknown = await response.json();
    if (typeof body !== "object" || body === null) return undefined;
    return (body as { child?: unknown }).child === true;
  } catch {
    return undefined;
  }
}
