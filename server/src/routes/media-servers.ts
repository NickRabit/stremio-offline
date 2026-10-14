import { once } from "node:events";
import type express from "express";
import { AppError } from "../errors.js";
import { log } from "../logger.js";
import { ResourceError } from "../media-resources.js";
import { ForbiddenError } from "../roles.js";
import { MEDIA_SERVER_LIMITS, MediaServerError, isMediaServerError } from "../media-server-types.js";
import type { MediaServerAuthority, MediaServerManager } from "../media-server-manager.js";
import type { MediaServerPersonal, RemoteCards } from "../media-server-personal.js";
import type { MediaServerSources } from "../media-server-sources.js";
import type { ResourceOwner } from "../media-resources.js";
import { asyncRoute, type RouteContext } from "./context.js";

export interface MediaServersDeps extends RouteContext {
  mediaServers: MediaServerManager;
  mediaSources: MediaServerSources;
  remotePersonal: MediaServerPersonal;
  ownerOf(req: express.Request): ResourceOwner;
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
export const toHttpError = (error: MediaServerError): AppError => {
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

/** The client went away before an answer could be written: nothing is sent and nothing is
 *  logged beyond the debug line, so a disconnect never becomes a 500. */
class ClientGone extends Error {}

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

const CARD_QUERY_KEYS = ["filter", "skip", "limit"];
const CARD_SKIP_MAX = 1000;
const CARD_LIMIT_MAX = 120;
const CARD_LIMIT_DEFAULT = 20;
const REMOVAL_QUERY_KEYS = ["forget"];

/** What one removal may carry: a body is refused, the only query key is `forget` and its only
 *  values are the two exact strings. Anything else -- an array, a nested object, another key --
 *  is refused before the manager is asked to change anything. */
const removalOptions = (req: express.Request): { forget?: boolean } | undefined => {
  assertNoBody(req);
  const query = req.query as Record<string, unknown>;
  for (const key of Object.keys(query)) {
    if (!REMOVAL_QUERY_KEYS.includes(key)) throw malformed("The media-server request has an unknown query field.");
  }
  const raw = query.forget;
  if (raw === undefined) return undefined;
  if (raw !== "true" && raw !== "false") throw malformed("The media-server forget flag is not supported.");
  return { forget: raw === "true" };
};

/** The personal card list takes three fixed query fields and nothing else: a required filter,
 *  a bounded skip and a bounded page. A body is refused like every other media-server read. */
const cardOptions = (req: express.Request): { filter: "resume" | "favorites"; skip: number; limit: number } => {
  assertNoBody(req);
  const query = req.query as Record<string, unknown>;
  for (const key of Object.keys(query)) {
    if (!CARD_QUERY_KEYS.includes(key)) throw malformed("The media-server request has an unknown query field.");
  }
  const filter = query.filter;
  if (filter !== "favorites" && filter !== "resume") throw malformed("The remote card filter is required.");
  const bounded = (raw: unknown, fallback: number, min: number, max: number): number => {
    if (raw === undefined || raw === "") return fallback;
    if (typeof raw !== "string" || !/^\d{1,4}$/.test(raw)) throw malformed("The remote card page is out of range.");
    const value = Number(raw);
    if (value < min || value > max) throw malformed("The remote card page is out of range.");
    return value;
  };
  return { filter, skip: bounded(query.skip, 0, 0, CARD_SKIP_MAX), limit: bounded(query.limit, CARD_LIMIT_DEFAULT, 1, CARD_LIMIT_MAX) };
};

/** The preview takes at most one opaque parent id and no body; every other key is refused
 *  before the manager re-proves the parent against the granted library. */
const previewParent = (req: express.Request): string | undefined => {
  assertNoBody(req);
  const query = req.query as Record<string, unknown>;
  for (const key of Object.keys(query)) {
    if (key !== "parentId" && key !== "artwork") throw malformed("The media-server request has an unknown query field.");
  }
  if (query.artwork !== undefined && query.artwork !== "children") throw malformed("The preview artwork mode is invalid.");
  const raw = query.parentId;
  if (raw === undefined) return undefined;
  if (typeof raw !== "string" || raw.length === 0 || raw.length > MEDIA_SERVER_LIMITS.upstreamId) {
    throw malformed("The media-server item id is missing or too long.");
  }
  return raw;
};

/** The streams route takes one optional `name` (a resolved catalogue or series title), bounded
 *  to 256 characters; every other query key is refused before the manager is asked to match. */
const streamName = (req: express.Request): string | undefined => {
  assertNoBody(req);
  const query = req.query as Record<string, unknown>;
  for (const key of Object.keys(query)) {
    if (key !== "name") throw malformed("The media-server request has an unknown query field.");
  }
  const raw = query.name;
  if (raw === undefined || raw === "") return undefined;
  if (typeof raw !== "string" || raw.length > 256) throw malformed("The media-server search term is too long.");
  return raw;
};

export function registerMediaServerRoutes(app: express.Application, deps: MediaServersDeps): void {
  const { mediaServers, mediaSources, remotePersonal, ownerOf, currentUser, requireAccess } = deps;

  /** The one request guard: the acting account, the captured library and connection, the abort
   *  wiring, and every re-check the response boundary repeats before a byte or a JSON value
   *  leaves. `after` runs between those checks and the send, for a route that carries its own
   *  projection proof. */
  const guardRequest = async <T>(
    req: express.Request,
    res: express.Response,
    member: boolean,
    fn: (req: express.Request, authority: MediaServerAuthority, signal: AbortSignal) => Promise<unknown>,
    after?: (authority: MediaServerAuthority, result: T) => void,
  ): Promise<T> => {
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
      const result = (await fn(req, authority, controller.signal)) as T;
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
      after?.(authority, result);
      return result;
    } catch (error) {
      if (isMediaServerError(error) && (error.code === "cancelled" || error.code === "closed") && controller.signal.aborted) {
        log("DEBUG", "Media-server request ended with the client", { path: req.path });
        throw new ClientGone();
      }
      if (error instanceof AppError || error instanceof ResourceError) throw error;
      if (isMediaServerError(error)) throw toHttpError(error);
      throw error;
    } finally {
      req.off("aborted", onClose);
      res.off("close", onClose);
    }
  };

  const handle = (
    fn: (req: express.Request, authority: MediaServerAuthority, signal: AbortSignal) => Promise<unknown>,
    status = 200,
    member = false,
  ): express.RequestHandler => asyncRoute(async (req, res) => {
    let result: unknown;
    try {
      result = await guardRequest(req, res, member, fn);
    } catch (error) {
      if (error instanceof ClientGone) return;
      throw error;
    }
    if (status === 204) res.status(status).end();
    else res.status(status).json(result);
  });

  const body = (req: express.Request): unknown => req.body ?? {};

  app.get("/api/media-servers", handle(async (req, authority) => {
    assertNoBody(req);
    assertNoQuery(req.query);
    return mediaServers.listConnections(authority);
  }));
  app.get("/api/media-servers/libraries", handle(async (req, authority) => {
    assertNoBody(req);
    assertNoQuery(req.query);
    return { libraries: await mediaServers.listAdminLibraries(authority) };
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
    mediaServers.removeConnection(authority, req.params.id, signal, removalOptions(req)), 204));
  app.patch("/api/remote-libraries/:id", handle(async (req, authority, signal) =>
    mediaServers.patchLibrary(authority, req.params.id, body(req), signal)));
  app.delete("/api/remote-libraries/:id", handle(async (req, authority, signal) =>
    mediaServers.deleteLibrary(authority, req.params.id, signal, removalOptions(req)), 204));
  app.get("/api/remote-libraries", handle(async (req, authority, signal) => {
    assertNoBody(req);
    assertNoQuery(req.query);
    return { libraries: await mediaServers.visibleLibraries(authority, signal) };
  }, 200, true));
  // Registered before the `:id` routes so the two-segment personal path is never read as a
  // library handle, and its projections are covered by the guard that reads every captured
  // library, not only one.
  app.get("/api/remote-libraries/personal", asyncRoute(async (req, res) => {
    const options = cardOptions(req);
    let result: RemoteCards;
    try {
      result = await guardRequest(
        req, res, true,
        (_request, authority, signal) => remotePersonal.cards(authority, options, signal),
        (authority, value) => remotePersonal.assertCardsCurrent(authority, value),
      );
    } catch (error) {
      if (error instanceof ClientGone) return;
      throw error;
    }
    res.status(200).json(result);
  }));
  app.get("/api/remote-libraries/:id/browse", handle(async (req, authority, signal) => {
    assertNoBody(req);
    return mediaServers.browseDirectory(authority, req.params.id, req.query, signal);
  }, 200, true));
  app.get("/api/remote-libraries/:id/preview", handle(async (req, authority, signal) => {
    const parentId = previewParent(req);
    return mediaServers.previewDirectory(authority, req.params.id, parentId, signal, req.query.artwork === "children");
  }, 200, true));
  app.get("/api/remote-libraries/:id/items/:itemId/episodes", handle(async (req, authority, signal) => {
    assertNoBody(req);
    return mediaServers.itemEpisodes(authority, req.params.id, req.params.itemId, req.query, signal);
  }, 200, true));
  app.get("/api/remote-libraries/:id/items/:itemId/sources", handle(async (req, authority, signal) => {
    assertNoBody(req);
    assertNoQuery(req.query);
    return { streams: await mediaSources.list(authority, ownerOf(req), String(req.params.id), String(req.params.itemId), signal) };
  }, 200, true));
  app.get("/api/remote-libraries/:id/streams/:type/:catalogId", handle(async (req, authority, signal) => {
    const name = streamName(req);
    return { streams: await mediaSources.matched(authority, ownerOf(req), String(req.params.id), String(req.params.type), String(req.params.catalogId), signal, name) };
  }, 200, true));
  // Fixed Primary|Backdrop only and at most the optional `tag` and `size` queries: the bytes
  // stream through the image lane. The browser may keep a successful response for a year, and
  // it is immutable only when the `tag` query equals the membership proof's tag. An If-None-Match
  // that does arrive is a local 304 once the manager's checks still hold.
  app.get("/api/remote-libraries/:id/items/:itemId/artwork/:imageType", asyncRoute(async (req, res) => {
    let response: Response;
    try {
      response = await guardRequest(req, res, true, (request, authority, signal) => {
        assertNoBody(request);
        const query = request.query as Record<string, unknown>;
        for (const key of Object.keys(query)) {
          if (key !== "tag" && key !== "size" && key !== "surface") throw malformed("The media-server request has an unknown query field.");
        }
        const tag = query.tag;
        const size = query.size;
        const surface = query.surface;
        if (surface !== undefined && surface !== "catalog" && surface !== "library" && surface !== "remote" && surface !== "home") {
          throw malformed("The image surface is not supported.");
        }
        const ifNoneMatch = request.header("if-none-match");
        return mediaServers.readArtwork(authority, request.params.id, request.params.itemId, String(request.params.imageType), signal, {
          ...(tag === undefined ? {} : { tag }),
          ...(ifNoneMatch === undefined ? {} : { ifNoneMatch }),
          ...(size === undefined ? {} : { size }),
          ...(surface === undefined ? {} : { surface }),
        });
      });
    } catch (error) {
      if (error instanceof ClientGone) return;
      throw error;
    }
    res.status(response.status);
    response.headers.forEach((value, name) => res.setHeader(name, value));
    if (response.status === 304 || !response.body) { res.end(); return; }
    const reader = response.body.getReader();
    const downstream = new AbortController();
    const onClose = () => { downstream.abort(); void reader.cancel().catch(() => undefined); };
    res.on("close", onClose);
    try {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        if (!res.write(Buffer.from(chunk.value))) await once(res, "drain", { signal: downstream.signal });
      }
      res.end();
    } catch (error) {
      log("DEBUG", "Media-server image stream ended early", { path: req.path, reason: error instanceof Error ? error.message : String(error) });
      res.destroy();
    } finally {
      res.off("close", onClose);
    }
  }));
  app.get("/api/remote-libraries/:id/items/:itemId/state", handle(async (req, authority, signal) => {
    assertNoBody(req);
    assertNoQuery(req.query);
    return remotePersonal.read(authority, req.params.id, req.params.itemId, signal);
  }, 200, true));
  app.patch("/api/remote-libraries/:id/items/:itemId/state", handle(async (req, authority, signal) =>
    remotePersonal.patch(authority, req.params.id, req.params.itemId, body(req), signal), 200, true));
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
