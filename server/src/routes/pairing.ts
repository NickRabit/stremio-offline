import type express from "express";
import { sessionCookie } from "../auth.js";
import { AppError } from "../errors.js";
import { PairingError, PairingRegistry } from "../pairing.js";
import { authRequestLimiter } from "../request-limits.js";
import { assertUnrestricted } from "../restricted.js";
import type { RouteContext } from "./context.js";

const JSON_ONLY = (req: express.Request): boolean =>
  typeof req.is(["application/json", "application/*+json"]) === "string";

export function registerPairingRoutes(
  app: express.Application,
  ctx: RouteContext,
  registry = new PairingRegistry(),
): void {
  const privateResponse: express.RequestHandler = (req, res, next) => {
    res.setHeader("cache-control", "private, no-store");
    res.setHeader("pragma", "no-cache");
    if (!JSON_ONLY(req)) return next(new AppError("This request must be JSON.", "err.invalidRequest", 415));
    next();
  };
  const browserIntent: express.RequestHandler = (req, _res, next) => {
    const fetchSite = req.get("sec-fetch-site");
    if (fetchSite !== undefined && fetchSite !== "same-origin") {
      return next(new AppError("This account may not do that.", "err.notAllowed", 403));
    }
    if (req.get("x-pairing-intent") !== "approve") {
      return next(new AppError("This account may not do that.", "err.notAllowed", 403));
    }
    next();
  };
  const startLimit = authRequestLimiter({ userId: () => undefined });
  const approvalLimit = authRequestLimiter({ userId: (req) => ctx.currentUser(req)?.id });
  const pollLimit = authRequestLimiter({ userId: () => undefined, limit: 120 });

  const authority = (req: express.Request) => {
    assertUnrestricted();
    const session = ctx.currentSession(req);
    const user = ctx.currentUser(req);
    if (!session || !user) throw new AppError("Not signed in.", "err.notSignedIn", 401);
    if (user.mustChangePassword) {
      throw new AppError("Change your password before continuing.", "err.mustChangePassword", 403);
    }
    ctx.requireAccess(req);
    return { session, user };
  };

  app.post("/api/auth/pair/start", privateResponse, startLimit, (req, res) => {
    assertUnrestricted();
    if (ctx.needsSetup()) throw new AppError("No account has been created yet.", "err.noAccount", 409);
    const started = registry.start(req.body?.deviceLabel);
    res.status(201).json(started);
  });

  app.post("/api/auth/pair/poll", privateResponse, pollLimit, (req, res, next) => {
    assertUnrestricted();
    try {
      const result = registry.poll(req.body?.pollToken, ctx.store.users(), (id) => ctx.store.prefs(id).uiLanguage);
      if (result.status === "pending") return res.json({ status: "pending" });
      res.setHeader("set-cookie", sessionCookie(result.token, true, ctx.isSecure(req)));
      return res.json({
        status: "approved",
        username: result.username,
        role: result.role,
        language: result.language,
      });
    } catch (error) {
      if (error instanceof PairingError && error.retryAfterMs) {
        res.setHeader("retry-after", String(Math.max(1, Math.ceil(error.retryAfterMs / 1000))));
      }
      next(error);
    }
  });

  app.post("/api/auth/pair/inspect", privateResponse, browserIntent, approvalLimit, (req, res) => {
    const { session } = authority(req);
    res.json(registry.inspect(req.body?.code, session, ctx.store.users()));
  });

  app.post("/api/auth/pair/approve", privateResponse, browserIntent, approvalLimit, (req, res) => {
    const { session } = authority(req);
    registry.approve(req.body?.code, req.body?.nonce, session, ctx.store.users());
    res.status(204).end();
  });

  app.post("/api/auth/pair/deny", privateResponse, browserIntent, approvalLimit, (req, res) => {
    const { session } = authority(req);
    registry.deny(req.body?.code, req.body?.nonce, session, ctx.store.users());
    res.status(204).end();
  });
}
