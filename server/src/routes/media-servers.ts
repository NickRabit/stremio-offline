import type express from "express";
import { AppError } from "../errors.js";
import { log } from "../logger.js";
import { ResourceError } from "../media-resources.js";
import { ForbiddenError } from "../roles.js";
import { MediaServerError, isMediaServerError } from "../media-server-types.js";
import type { MediaServerAuthority, MediaServerManager } from "../media-server-manager.js";
import { asyncRoute, type RouteContext } from "./context.js";

export interface MediaServersDeps extends RouteContext {
  mediaServers: MediaServerManager;
}

/** Fixed English text for every mapped failure. The internal message is never forwarded: a
 *  provider or a bug must not be able to place its own text in an API response. */
const TEXTS = Object.freeze({
  invalidRequest: "The request was not understood.",
  libraryNotFound: "The library was not found.",
  busy: "The media server is busy. Try again shortly.",
  unavailable: "The media server is unavailable.",
  login: "The media-server connection needs an administrator to sign in again.",
  key: "The media-server secret key is unavailable.",
  stale: "The media-server configuration changed. Try again.",
  identity: "The media-server identity changed. Recreate the connection.",
  restricted: "This media-server account has unsupported restrictions.",
});

/** A bound on how long a client is told to wait. Both ends of the range are clamped so the
 *  seconds value is always a usable, finite one. */
const withRetryAfter = (text: string, key: string, retryAfterMs: number | undefined): AppError => {
  const error = new AppError(text, key, 429);
  if (typeof retryAfterMs === "number" && Number.isFinite(retryAfterMs) && retryAfterMs > 0) {
    (error as { retryAfterMs?: number }).retryAfterMs = Math.min(300_000, Math.max(1_000, retryAfterMs));
  }
  return error;
};

/** The single place an internal failure becomes a sentence and a status. Every declared code
 *  maps to a fixed key; an unknown one falls back to a plain 502 rather than leaking a raw
 *  status or message. An upstream 401 becomes a local 502, never a session 401. */
const toHttpError = (error: MediaServerError): AppError => {
  switch (error.code) {
    case "invalid-input":
      return new AppError(TEXTS.invalidRequest, "err.invalidRequest", 400);
    case "not-found":
    case "forbidden":
      return new AppError(TEXTS.libraryNotFound, "err.libraryNotFound", 404);
    case "busy":
    case "rate-limited":
      return withRetryAfter(TEXTS.busy, "err.mediaServerBusy", error.retryAfterMs);
    case "stale-generation":
      return new AppError(TEXTS.stale, "err.mediaServerStale", 409);
    case "identity-changed":
      return new AppError(TEXTS.identity, "err.mediaServerIdentity", 409);
    case "unsupported-policy":
      return new AppError(TEXTS.restricted, "err.mediaServerRestricted", 403);
    case "authentication-required":
      return new AppError(TEXTS.login, "err.mediaServerLogin", 502);
    case "secret-key-unavailable":
    case "secret-unavailable":
      return new AppError(TEXTS.key, "err.mediaServerKey", 503);
    case "closed":
    case "cancelled":
      return new AppError(TEXTS.unavailable, "err.mediaServerUnavailable", 503);
    case "timeout":
    case "unavailable":
    case "invalid-response":
    case "response-too-large":
    case "unsafe-address":
      return new AppError(TEXTS.unavailable, "err.mediaServerUnavailable", 502);
    default:
      return new AppError(TEXTS.unavailable, "err.mediaServerUnavailable", 502);
  }
};

const malformed = (message: string): MediaServerError => new MediaServerError("invalid-input", message);

const assertNoBody = (req: express.Request): void => {
  if (req.body !== undefined || Number(req.header("content-length") ?? 0) > 0 || req.header("transfer-encoding")) {
    throw malformed("The media-server request must not carry a body.");
  }
};

const assertNoQuery = (query: unknown): void => {
  if (query === undefined || query === null) return;
  if (typeof query !== "object" || Array.isArray(query)) throw malformed("The media-server query is malformed.");
  if (Object.keys(query as object).length > 0) throw malformed("The media-server request has an unknown query field.");
};

export function registerMediaServerRoutes(app: express.Application, deps: MediaServersDeps): void {
  const { mediaServers, currentUser, requireAccess } = deps;

  const handle = (
    fn: (req: express.Request, authority: MediaServerAuthority, signal: AbortSignal) => Promise<unknown>,
    status = 200,
    member = false,
  ): express.RequestHandler => asyncRoute(async (req, res) => {
    const user = currentUser(req);
    if (!user) throw new ResourceError(401, "AUTH_REQUIRED");
    const permissionStamp = user.permissionsVersion;
    const authority: MediaServerAuthority = { actor: { id: user.id, secret: user.secret }, assertCurrent: () => requireAccess(req) };
    const library = req.method === "GET" && member ? deps.store.remoteLibraries().find((entry) => entry.id === req.params.id) : undefined;
    const connection = library ? deps.store.mediaConnections().find((entry) => entry.id === library.connectionId) : undefined;
    const controller = new AbortController();
    const onClose = () => { if (!res.writableEnded) controller.abort(); };
    req.on("aborted", onClose);
    res.on("close", onClose);
    try {
      const result = await fn(req, authority, controller.signal);
      authority.assertCurrent();
      const current = currentUser(req);
      if (!current || current.id !== authority.actor.id || current.secret !== authority.actor.secret || current.disabled || current.mustChangePassword) {
        throw new ResourceError(401, "AUTH_REQUIRED");
      }
      if (!member && current.role !== "admin") throw new ForbiddenError();
      if (current.permissionsVersion !== permissionStamp) throw new ResourceError(404, "RESOURCE_NOT_FOUND");
      if (library) {
        const fresh = deps.store.remoteLibraries().find((entry) => entry.id === library.id);
        const upstream = fresh ? deps.store.mediaConnections().find((entry) => entry.id === fresh.connectionId) : undefined;
        if (!fresh?.enabled || !upstream?.enabled || (current.role !== "admin" && !fresh.allowedUsers.includes(current.id))) {
          throw new ResourceError(404, "RESOURCE_NOT_FOUND");
        }
        if (upstream.generation !== connection?.generation || upstream.secretRef !== connection?.secretRef) {
          throw new MediaServerError("stale-generation", "The media-server configuration changed.");
        }
      }
      if (controller.signal.aborted) throw new MediaServerError("cancelled", "The media-server request was cancelled.");
      if (status === 204) res.status(status).end();
      else res.status(status).json(result);
    } catch (error) {
      if (isMediaServerError(error) && (error.code === "cancelled" || error.code === "closed") && controller.signal.aborted) {
        log("DEBUG", "Media-server request ended with the client", { path: req.path });
        return;
      }
      if (error instanceof AppError || error instanceof ResourceError) throw error;
      if (isMediaServerError(error)) throw toHttpError(error);
      throw error;
    } finally {
      req.off("aborted", onClose);
      res.off("close", onClose);
    }
  });

  const body = (req: express.Request): unknown => req.body ?? {};

  app.get("/api/media-servers", handle(async (req, authority) => {
    assertNoBody(req);
    assertNoQuery(req.query);
    return mediaServers.listConnections(authority);
  }));
  app.get("/api/media-servers/export", handle(async (req, authority) => {
    assertNoBody(req);
    assertNoQuery(req.query);
    return mediaServers.exportConfiguration(authority);
  }));
  app.post("/api/media-servers/import", handle(async (req, authority, signal) =>
    mediaServers.importConfiguration(authority, body(req), signal), 201));
  app.post("/api/media-servers", handle(async (req, authority, signal) =>
    mediaServers.createConnection(authority, body(req), signal), 201));
  app.post("/api/media-servers/:id/reauthenticate", handle(async (req, authority, signal) =>
    mediaServers.reauthenticate(authority, req.params.id, body(req), signal)));
  app.get("/api/media-servers/:id/libraries", handle(async (req, authority, signal) => {
    assertNoBody(req);
    assertNoQuery(req.query);
    return { items: await mediaServers.discoverLibraries(authority, req.params.id, signal) };
  }));
  app.post("/api/media-servers/:id/libraries", handle(async (req, authority, signal) =>
    mediaServers.attachLibrary(authority, req.params.id, body(req), signal), 201));
  app.patch("/api/media-servers/:id", handle(async (req, authority, signal) =>
    mediaServers.patchConnection(authority, req.params.id, body(req), signal)));
  app.delete("/api/media-servers/:id", handle(async (req, authority, signal) =>
    mediaServers.removeConnection(authority, req.params.id, signal), 204));
  app.patch("/api/remote-libraries/:id", handle(async (req, authority, signal) =>
    mediaServers.patchLibrary(authority, req.params.id, body(req), signal)));
  app.delete("/api/remote-libraries/:id", handle(async (req, authority, signal) =>
    mediaServers.deleteLibrary(authority, req.params.id, signal), 204));
  app.get("/api/remote-libraries", handle(async (req, authority, signal) => {
    assertNoBody(req);
    assertNoQuery(req.query);
    return { libraries: await mediaServers.visibleLibraries(authority, signal) };
  }, 200, true));
  app.get("/api/remote-libraries/:id/items/:itemId/episodes", handle(async (req, authority, signal) => {
    assertNoBody(req);
    return mediaServers.itemEpisodes(authority, req.params.id, req.params.itemId, req.query, signal);
  }, 200, true));
  app.get("/api/remote-libraries/:id/items/:itemId", handle(async (req, authority, signal) => {
    assertNoBody(req);
    assertNoQuery(req.query);
    return mediaServers.itemDetail(authority, req.params.id, req.params.itemId, signal);
  }, 200, true));
  app.get("/api/remote-libraries/:id/items", handle(async (req, authority, signal) => {
    assertNoBody(req);
    return mediaServers.browseItems(authority, req.params.id, req.query, signal);
  }, 200, true));
}
