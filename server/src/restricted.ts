import type { Request, RequestHandler } from "express";
import { AppError } from "./errors.js";

export const restrictedMode = (): boolean => process.env.RESTRICTED_MODE === "1";

export class RestrictedError extends AppError {
  constructor() {
    super("This instance is in restricted mode.", "err.restricted", 403);
  }
}

export function assertUnrestricted(): void {
  if (restrictedMode()) throw new RestrictedError();
}

/** True when this-device sign-out must not rotate every other session. */
export function logoutDenied(body: unknown): boolean {
  return restrictedMode() && Boolean((body as { everywhere?: unknown } | null)?.everywhere);
}

type Rule = { method: string; pattern: RegExp };
const match = (rules: Rule[], method: string, path: string) =>
  rules.some((rule) => rule.method === method.toUpperCase() && rule.pattern.test(path));

/** Paths are Express-stripped of the `/api` mount, matching OPEN_PATHS (`/addons`, not `/api/addons`). */
export const DENIED_GETS: Rule[] = [
  { method: "GET", pattern: /^\/addons\/[^/]+\/export$/ },
  { method: "GET", pattern: /^\/settings\/export$/ },
  { method: "GET", pattern: /^\/logs$/ },
  { method: "GET", pattern: /^\/diagnostics$/ },
  // Both name directories on the host, which the picker exists to disclose on an install
  // whose owner is at the keyboard. `GET /libraries` stays allowed: it carries names,
  // types and counts, and the interface renders nothing else.
  { method: "GET", pattern: /^\/libraries\/browse$/ },
  { method: "GET", pattern: /^\/libraries\/grants$/ },
];

/** Authenticated writes that remain legal in restricted mode. Open paths are skipped before this list. */
export const ALLOWED_MUTATIONS: Rule[] = [
  { method: "POST", pattern: /^\/auth\/logout$/ },
  { method: "POST", pattern: /^\/watchlist$/ },
  { method: "POST", pattern: /^\/progress$/ },
  { method: "DELETE", pattern: /^\/progress\/[^/]+$/ },
  { method: "POST", pattern: /^\/library\/favorite$/ },
  { method: "POST", pattern: /^\/library\/source$/ },
  { method: "POST", pattern: /^\/library\/rename$/ },
  { method: "POST", pattern: /^\/library\/move$/ },
  { method: "POST", pattern: /^\/library\/match$/ },
  { method: "POST", pattern: /^\/library\/scan$/ },
  { method: "POST", pattern: /^\/library\/scan\/stop$/ },
  { method: "DELETE", pattern: /^\/library\/suggestion$/ },
  { method: "DELETE", pattern: /^\/library\/item$/ },
  { method: "POST", pattern: /^\/downloads$/ },
  { method: "POST", pattern: /^\/downloads\/bulk$/ },
  { method: "POST", pattern: /^\/downloads\/[^/]+\/(pause|resume|retry|move)$/ },
  { method: "DELETE", pattern: /^\/downloads\/[^/]+$/ },
  { method: "DELETE", pattern: /^\/downloads$/ },
  { method: "POST", pattern: /^\/device-download$/ },
  { method: "POST", pattern: /^\/client-log$/ },
  { method: "POST", pattern: /^\/inspect$/ },
  { method: "POST", pattern: /^\/playback$/ },
  { method: "POST", pattern: /^\/playback\/[^/]+\/(ping|seek|escalate|track)$/ },
  { method: "DELETE", pattern: /^\/playback\/[^/]+$/ },
];

export const isDeniedGet = (method: string, path: string) => match(DENIED_GETS, method, path);
export const isAllowedMutation = (method: string, path: string) => match(ALLOWED_MUTATIONS, method, path);

export const restrictedMiddleware = (opts: {
  isOpen: (req: Request) => boolean;
  isInternal: (req: Request) => boolean;
}): RequestHandler =>
  (req, _res, next) => {
    if (!restrictedMode()) return next();
    if (opts.isOpen(req) || opts.isInternal(req)) return next();
    if (isDeniedGet(req.method, req.path)) return next(new RestrictedError());
    if (req.method.toUpperCase() !== "GET" && !isAllowedMutation(req.method, req.path)) {
      return next(new RestrictedError());
    }
    next();
  };
