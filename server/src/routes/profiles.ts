import type express from "express";
import { createSession, pruneRevoked, sessionCookie, verifyPassword } from "../auth.js";
import { AppError } from "../errors.js";
import { log } from "../logger.js";
import { profileAttempts } from "../profile-attempts.js";
import { assertUnrestricted, restrictedMode } from "../restricted.js";
import type { State } from "../store.js";
import { effectiveUnlock, findUserById, switcherGroup, type UserRecord } from "../users.js";
import { asyncRoute, type RouteContext } from "./context.js";

const profileUnavailable = () =>
  new AppError("That profile is not available.", "err.profileUnavailable", 404);

const withUser = (state: State, id: string, change: (user: UserRecord) => UserRecord) => {
  state.users = (state.users ?? []).map((user) => user.id === id ? change(user) : user);
};

export function registerProfilesRoutes(app: express.Application, ctx: RouteContext): void {
  app.get("/api/profiles", (req, res) => {
    res.setHeader("cache-control", "private, no-store");
    const caller = ctx.currentUser(req);
    if (!caller) throw new AppError("Not signed in.", "err.notSignedIn", 401);
    const group = restrictedMode() ? [] : switcherGroup(ctx.store.users(), caller.id);
    res.json({
      profiles: group.map((user) => {
        const unlock = effectiveUnlock(user);
        return {
          id: user.id,
          username: user.username,
          unlock,
          current: user.id === caller.id,
          ...(unlock === "pin" ? { pinLocked: profileAttempts.pinLocked(user.id) } : {}),
        };
      }),
    });
  });

  app.post("/api/profiles/switch", asyncRoute(async (req, res) => {
    res.setHeader("cache-control", "private, no-store");
    const info = ctx.currentSession(req);
    const caller = ctx.currentUser(req);
    if (!info || !caller) throw new AppError("Not signed in.", "err.notSignedIn", 401);
    assertUnrestricted();

    const id = req.body?.id;
    const pin = req.body?.pin;
    const password = req.body?.password;
    if (typeof id !== "string"
      || (pin !== undefined && typeof pin !== "string")
      || (password !== undefined && typeof password !== "string")) {
      throw new AppError("The request is not valid.", "err.invalidRequest", 400);
    }

    const target = switcherGroup(ctx.store.users(), caller.id)
      .find((user) => user.id === id && user.id !== caller.id);
    if (!target) throw profileUnavailable();

    const wait = profileAttempts.retryAfterMs(target.id);
    if (wait > 0) {
      const seconds = Math.ceil(wait / 1000);
      res.setHeader("retry-after", String(seconds));
      return res.status(429).json({
        error: `Too many failed attempts. Try again in ${seconds} s.`,
        messageKey: "err.tooManyAttempts",
        vars: { seconds },
      });
    }

    const usePassword = typeof password === "string" && password.length > 0;
    const method = effectiveUnlock(target);
    let checkedPasswordHash: string | undefined;
    let checkedPinHash: string | undefined;
    let failure: AppError | undefined;

    if (!usePassword && method === "pin" && profileAttempts.pinLocked(target.id)) {
      return res.status(403).json({ error: "Too many wrong PINs. Use the password.", messageKey: "err.pinLocked" });
    }
    // Counted before the hash and cleared on success: requests sent together would otherwise
    // all read the count as it stood before any of them failed, and none would ever wait.
    const wasLocked = profileAttempts.pinLocked(target.id);
    if (usePassword || method !== "none") profileAttempts.fail(target.id);

    if (usePassword) {
      if (await verifyPassword(password, target.passwordHash)) checkedPasswordHash = target.passwordHash;
      else failure = new AppError("Wrong username or password.", "err.badCredentials", 401);
    } else if (method === "pin") {
      if (typeof pin === "string" && target.pinHash && await verifyPassword(pin, target.pinHash)) {
        checkedPinHash = target.pinHash;
      } else {
        failure = new AppError("Wrong PIN.", "err.badPin", 401);
      }
    } else if (method === "password") {
      failure = new AppError("Wrong username or password.", "err.badCredentials", 401);
    }

    if (failure) {
      const logMethod = usePassword ? "password" : method;
      log("WARN", "Failed profile switch", {
        from: caller.username,
        fromId: caller.id,
        to: target.username,
        toId: target.id,
        method: logMethod,
      });
      if (!wasLocked && profileAttempts.pinLocked(target.id)) {
        log("WARN", "PIN locked", { username: target.username, userId: target.id });
      }
      // Answered here like a failed sign-in: a wrong secret is not a server error worth a stack.
      return res.status(failure.status ?? 401).json({ error: failure.message, messageKey: failure.messageKey });
    }

    let tokenSecret = "";
    await ctx.store.update((state) => {
      const liveCaller = findUserById(state.users ?? [], caller.id);
      const liveTarget = findUserById(state.users ?? [], target.id);
      if (!liveCaller || !liveTarget
        || liveCaller.secret !== caller.secret
        || !switcherGroup(state.users ?? [], liveCaller.id).some((user) => user.id === liveTarget.id)
        || (checkedPasswordHash !== undefined && liveTarget.passwordHash !== checkedPasswordHash)
        || (checkedPinHash !== undefined && (liveTarget.pinHash !== checkedPinHash || effectiveUnlock(liveTarget) !== "pin"))
        || (checkedPasswordHash === undefined && checkedPinHash === undefined && effectiveUnlock(liveTarget) !== "none")) {
        throw profileUnavailable();
      }
      withUser(state, caller.id, (user) => ({
        ...user,
        revoked: { ...pruneRevoked(user.revoked), [info.sid]: info.expiresAt },
      }));
      withUser(state, target.id, (user) => ({ ...user, lastSeenAt: new Date().toISOString() }));
      tokenSecret = liveTarget.secret;
    });

    const token = createSession(tokenSecret, target.id, info.expiresAt);
    res.setHeader("set-cookie", sessionCookie(
      token,
      true,
      ctx.isSecure(req),
      Math.max(1, Math.floor((info.expiresAt - Date.now()) / 1000)),
    ));
    profileAttempts.succeed(target.id);
    await ctx.stopOwnedPlayback(info.sid);
    ctx.forgetMediaPlayback?.(caller.id);
    log("INFO", "Profile switch", {
      from: caller.username,
      fromId: caller.id,
      to: target.username,
      toId: target.id,
      method: usePassword ? "password" : method,
    });
    res.json({
      username: target.username,
      role: target.role,
      language: ctx.store.prefs(target.id).uiLanguage,
      mustChangePassword: false,
    });
  }));
}
