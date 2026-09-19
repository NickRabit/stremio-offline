import type express from "express";
import type { SessionInfo } from "../auth.js";
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
  /** Tears down the media, playback and device-download resources of one
   *  session, or of every session when `sid` is omitted. */
  stopOwnedPlayback(sid?: string): Promise<void>;
}

export const asyncRoute = (fn: express.RequestHandler): express.RequestHandler =>
  (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
