import type express from "express";
import type { SessionInfo } from "../auth.js";
import type { Viewer } from "../libraries.js";
import { ResourceError } from "../media-resources.js";
import type { AccessNeed, StopContentOptions } from "../revocation.js";
import type { Store } from "../store.js";
import type { UserRecord } from "../users.js";

/** What a route module needs from the server it is mounted on. Grows one field
 *  at a time as further areas move out of index.ts. */
export interface RouteContext {
  store: Store;
  /** No stored account and no fallback credentials: only setup can proceed. */
  needsSetup(): boolean;
  currentSession(req: express.Request): SessionInfo | undefined;
  /** The account the request speaks for, or nothing when it carries no usable session. */
  currentUser(req: express.Request): UserRecord | undefined;
  isSecure(req: express.Request): boolean;
  /** Tears down the media, playback and device-download resources of one session.
   *  Another device of the same person is left alone. */
  stopOwnedPlayback(sid: string): Promise<void>;
  /** Everything one account holds, across all its devices. A password change and a
   *  sign-out everywhere reach this rather than the session sweep. */
  stopUserAccess(userId: string): Promise<void>;
  /** Only what the account holds open. A sign-out must not touch its download queue. */
  stopUserSessions(userId: string): Promise<void>;
  /** Refuses at the moment a resource is issued or a transfer started: the account, its
   *  session, the secret behind the token, the rights and the content as they stand now. */
  requireAccess(req: express.Request, need?: AccessNeed): void;
  /** One account's hold on one library or addon, or everybody's when no user is named. */
  stopContentAccess(opts: StopContentOptions): Promise<void>;
}

export const asyncRoute = (fn: express.RequestHandler): express.RequestHandler =>
  (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

/** The account a request speaks for, as much of it as a library visibility check needs.
 *  Every route that serves a person runs behind the sign-in gate, so a request that names
 *  nobody is a bug rather than a case. */
export const viewerOf = (user: UserRecord | undefined): Viewer => {
  if (!user) throw new ResourceError(401, "AUTH_REQUIRED");
  return { id: user.id, role: user.role };
};
