import type { Request, RequestHandler } from "express";
import { AppError } from "./errors.js";
import type { Role } from "./users.js";

export class ForbiddenError extends AppError {
  constructor() { super("This account may not do that.", "err.notAllowed", 403); }
}

type Rule = { method: string; pattern: RegExp };
const match = (rules: Rule[], method: string, path: string) =>
  rules.some((rule) => rule.method === method.toUpperCase() && rule.pattern.test(path));

/** What an ordinary user may reach. Anything not here is administrator-only:
 *  a route added later is refused until somebody decides otherwise, which is
 *  the safe direction for a gate whose failure mode is disclosure.
 *  Paths are Express-stripped of the `/api` mount, matching `restricted.ts`. */
export const USER_ALLOWED: Rule[] = [
  // Their own account and session.
  { method: "GET", pattern: /^\/auth\/me$/ },
  { method: "POST", pattern: /^\/auth\/login$/ },
  { method: "POST", pattern: /^\/auth\/logout$/ },
  { method: "PATCH", pattern: /^\/auth\/password$/ },
  // Their own rows: watchlist, progress, favourites and resume.
  { method: "GET", pattern: /^\/watchlist$/ },
  { method: "POST", pattern: /^\/watchlist$/ },
  { method: "GET", pattern: /^\/progress$/ },
  { method: "GET", pattern: /^\/progress\/[^/]+$/ },
  { method: "POST", pattern: /^\/progress$/ },
  { method: "DELETE", pattern: /^\/progress$/ },
  { method: "DELETE", pattern: /^\/progress\/[^/]+$/ },
  { method: "GET", pattern: /^\/library\/favorites$/ },
  { method: "GET", pattern: /^\/library\/resume$/ },
  { method: "POST", pattern: /^\/library\/favorite$/ },
  // Browsing and playing.
  { method: "GET", pattern: /^\/library$/ },
  { method: "GET", pattern: /^\/library\/browse$/ },
  { method: "GET", pattern: /^\/library\/thumb$/ },
  { method: "GET", pattern: /^\/library\/next\/[^/]+$/ },
  { method: "GET", pattern: /^\/library\/previous\/[^/]+$/ },
  { method: "POST", pattern: /^\/library\/source$/ },
  { method: "GET", pattern: /^\/libraries$/ },
  { method: "GET", pattern: /^\/catalogs$/ },
  { method: "GET", pattern: /^\/catalog$/ },
  { method: "GET", pattern: /^\/search$/ },
  { method: "GET", pattern: /^\/searchable$/ },
  { method: "GET", pattern: /^\/meta\/[^/]+\/[^/]+$/ },
  { method: "GET", pattern: /^\/links\/[^/]+\/[^/]+$/ },
  { method: "GET", pattern: /^\/trailer\/[^/]+\/[^/]+$/ },
  { method: "GET", pattern: /^\/library\/links$/ },
  { method: "GET", pattern: /^\/library\/trailer$/ },
  { method: "GET", pattern: /^\/image\/[^/]+$/ },
  { method: "GET", pattern: /^\/stream-sources\/[^/]+\/[^/]+$/ },
  { method: "GET", pattern: /^\/streams\/[^/]+\/[^/]+$/ },
  { method: "GET", pattern: /^\/subtitles\/[^/]+\/[^/]+$/ },
  { method: "GET", pattern: /^\/subtitle\/[^/]+$/ },
  { method: "GET", pattern: /^\/addons$/ },
  { method: "GET", pattern: /^\/languages$/ },
  { method: "GET", pattern: /^\/settings$/ },
  { method: "POST", pattern: /^\/inspect$/ },
  { method: "POST", pattern: /^\/playback$/ },
  { method: "POST", pattern: /^\/playback\/[^/]+\/(ping|seek|escalate|track)$/ },
  { method: "GET", pattern: /^\/playback\/[^/]+\/preview$/ },
  { method: "GET", pattern: /^\/playback\/[^/]+\/sidecar\.vtt$/ },
  { method: "GET", pattern: /^\/playback\/[^/]+\/[^/]+\/[^/]+$/ },
  { method: "DELETE", pattern: /^\/playback\/[^/]+$/ },
  { method: "GET", pattern: /^\/media\/[^/]+$/ },
  { method: "GET", pattern: /^\/media\/[^/]+\/u\/[^/]+$/ },
  { method: "POST", pattern: /^\/device-download$/ },
  { method: "GET", pattern: /^\/device-download\/[^/]+$/ },
  { method: "POST", pattern: /^\/client-log$/ },
  // Downloads. Which jobs are theirs is the next task; here only the path passes.
  { method: "GET", pattern: /^\/downloads$/ },
  { method: "POST", pattern: /^\/downloads$/ },
  { method: "POST", pattern: /^\/downloads\/bulk$/ },
  { method: "POST", pattern: /^\/downloads\/[^/]+\/(pause|resume|retry)$/ },
  { method: "DELETE", pattern: /^\/downloads\/[^/]+$/ },
  // Settings: allowed at the path level, guarded per key inside the handler.
  { method: "PATCH", pattern: /^\/settings$/ },
];

export const isUserAllowed = (method: string, path: string) => match(USER_ALLOWED, method, path);

/** What an account whose password an administrator chose may still reach: the three calls
 *  that let it read its own name, replace that password and sign out. Everything else is
 *  refused, because the password it carries is one two people know. */
export const MUST_CHANGE_ALLOWED: Rule[] = [
  { method: "GET", pattern: /^\/auth\/me$/ },
  { method: "PATCH", pattern: /^\/auth\/password$/ },
  { method: "POST", pattern: /^\/auth\/logout$/ },
];

export const isMustChangePathAllowed = (method: string, path: string) => match(MUST_CHANGE_ALLOWED, method, path);

export const roleMiddleware = (opts: {
  isOpen: (req: Request) => boolean;
  isInternal: (req: Request) => boolean;
  roleOf: (req: Request) => Role | undefined;
}): RequestHandler =>
  (req, _res, next) => {
    if (opts.isOpen(req) || opts.isInternal(req)) return next();
    if (opts.roleOf(req) !== "user") return next();
    if (isUserAllowed(req.method, req.path)) return next();
    next(new ForbiddenError());
  };

/** The gate beside the role gate: a session that still owes a password change reaches only
 *  the account endpoints, whatever its role is. Refused rather than redirected, so a client
 *  that never saw the flag cannot browse or download behind it. */
export const passwordChangeMiddleware = (opts: {
  isOpen: (req: Request) => boolean;
  isInternal: (req: Request) => boolean;
  mustChange: (req: Request) => boolean | undefined;
}): RequestHandler =>
  (req, _res, next) => {
    if (opts.isOpen(req) || opts.isInternal(req)) return next();
    if (!opts.mustChange(req)) return next();
    if (isMustChangePathAllowed(req.method, req.path)) return next();
    next(new AppError("Change your password before continuing.", "err.mustChangePassword", 403));
  };
