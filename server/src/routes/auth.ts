import type express from "express";
import { randomBytes } from "node:crypto";
import { clearedCookie, createSession, DECOY_HASH, envCredentials, hashPassword, LoginThrottle, pruneRevoked, REMEMBER_DAYS, secretEquals, sessionCookie, verifyPassword } from "../auth.js";
import { AppError } from "../errors.js";
import { isUiLanguage } from "../language.js";
import { log } from "../logger.js";
import { logoutDenied, RestrictedError } from "../restricted.js";
import { asyncRoute, type RouteContext } from "./context.js";

const logins = new LoginThrottle();

export function registerAuthRoutes(app: express.Application, ctx: RouteContext): void {
  app.get("/api/auth/me", (req, res) => {
    // The language rides along on the one call the sign-in and setup screens can make
    // unauthenticated; without it they would render before knowing which one to use.
    const language = ctx.store.settings().uiLanguage;
    if (ctx.needsSetup()) return res.json({ setup: true, language });
    const user = ctx.currentUser(req);
    if (!user) return res.status(401).json({ error: "Not signed in.", messageKey: "err.notSignedIn", language });
    res.json({ username: user, language });
  });

  /** First-run account setup. Available only until an account exists. */
  app.post("/api/auth/setup", asyncRoute(async (req, res) => {
    if (!ctx.needsSetup()) throw new AppError("An account already exists.", "err.setupDone");
    const username = String(req.body.username ?? "").trim();
    const password = String(req.body.password ?? "");
    if (username.length < 3) throw new AppError("The username needs at least 3 characters.", "auth.usernameTooShort");
    if (password.length < 6) throw new AppError("The password needs at least 6 characters.", "auth.passwordTooShort");
    const language = isUiLanguage(req.body.language) ? req.body.language : undefined;
    const passwordHash = await hashPassword(password);
    const nextSecret = randomBytes(32).toString("hex");
    await ctx.store.update((state) => {
      state.auth = { username, passwordHash, secret: nextSecret, isDefault: false, revoked: {} };
      // The first-run language choice is also the best guess at which audio and
      // subtitles this household wants. Both stay editable in Settings afterwards.
      // A client that sends no language leaves the interface where it is, and the
      // tracks still follow it -- otherwise they would keep the English default.
      const chosen = language ?? state.settings.uiLanguage;
      state.settings = { ...state.settings, uiLanguage: chosen, audioLanguage: chosen, subtitleLanguage: chosen };
    });
    res.setHeader("set-cookie", sessionCookie(createSession(nextSecret, username, Date.now() + REMEMBER_DAYS * 24 * 60 * 60 * 1000), true, ctx.isSecure(req)));
    log("INFO", "Account created on first run", { username, language });
    res.status(201).json({ username, language: ctx.store.settings().uiLanguage });
  }));
  app.post("/api/auth/login", asyncRoute(async (req, res) => {
    const username = String(req.body.username ?? "");
    const password = String(req.body.password ?? "");
    const remember = Boolean(req.body.remember);
    const from = req.ip ?? "unknown";
    const wait = logins.retryAfterMs(from);
    if (wait > 0) {
      const seconds = Math.ceil(wait / 1000);
      log("WARN", "Sign-in refused after repeated failures", { username, from, waitSeconds: seconds });
      res.setHeader("retry-after", String(seconds));
      return res.status(429).json({ error: `Too many failed attempts. Try again in ${seconds} s.`, messageKey: "err.tooManyAttempts", vars: { seconds } });
    }
    const stored = ctx.store.auth();
    const fromEnv = envCredentials();
    // The hash is always computed, even for a name nobody has: a short circuit here
    // would answer an unknown name faster and hand out the list of real ones.
    const passwordMatches = await verifyPassword(password, stored?.passwordHash ?? DECOY_HASH);
    const bySettings = passwordMatches && Boolean(stored) && secretEquals(username, stored?.username ?? "");
    const byEnv = Boolean(fromEnv) && secretEquals(username, fromEnv?.username ?? "") && secretEquals(password, fromEnv?.password ?? "");
    if (!bySettings && !byEnv) {
      logins.fail(from);
      log("WARN", "Failed sign-in", { username, from });
      return res.status(401).json({ error: "Wrong username or password.", messageKey: "err.badCredentials" });
    }
    logins.succeed(from);
    const expiresAt = Date.now() + (remember ? REMEMBER_DAYS : 1) * 24 * 60 * 60 * 1000;
    res.setHeader("set-cookie", sessionCookie(createSession(ctx.secret(), username, expiresAt), remember, ctx.isSecure(req)));
    log("INFO", "Sign-in", { username, remember, viaEnvCredentials: byEnv && !bySettings });
    res.json({ username });
  }));
  app.post("/api/auth/logout", asyncRoute(async (req, res) => {
    if (logoutDenied(req.body)) throw new RestrictedError();
    const info = ctx.currentSession(req);
    res.setHeader("set-cookie", clearedCookie());
    if (!info) return res.status(204).end();
    if (req.body?.everywhere) {
      // A new secret invalidates every token issued so far at once.
      const nextSecret = randomBytes(32).toString("hex");
      await ctx.store.update((state) => { if (state.auth) state.auth = { ...state.auth, secret: nextSecret, revoked: {} }; });
      log("INFO", "Signed out on all devices", { username: info.username });
    } else {
      await ctx.store.update((state) => {
        if (state.auth) state.auth = { ...state.auth, revoked: { ...pruneRevoked(state.auth.revoked), [info.sid]: info.expiresAt } };
      });
      log("INFO", "Sign-out", { username: info.username });
    }
    await ctx.stopOwnedPlayback(req.body?.everywhere ? undefined : info.sid);
    res.status(204).end();
  }));
  app.patch("/api/auth/password", asyncRoute(async (req, res) => {
    const stored = ctx.store.auth();
    if (!stored) throw new AppError("No account has been created yet.", "err.noAccount");
    const current = String(req.body.currentPassword ?? "");
    if (!await verifyPassword(current, stored.passwordHash)) throw new AppError("The current password is wrong.", "err.wrongCurrentPassword");
    const nextPassword = String(req.body.newPassword ?? "");
    if (nextPassword.length < 6) throw new AppError("The new password needs at least 6 characters.", "auth.newPasswordTooShort");
    const username = String(req.body.username ?? stored.username).trim() || stored.username;
    const passwordHash = await hashPassword(nextPassword);
    // A new secret invalidates every token issued so far, other devices included.
    const nextSecret = randomBytes(32).toString("hex");
    await ctx.store.update((state) => { state.auth = { username, passwordHash, secret: nextSecret, isDefault: false, revoked: {} }; });
    res.setHeader("set-cookie", sessionCookie(createSession(nextSecret, username, Date.now() + REMEMBER_DAYS * 24 * 60 * 60 * 1000), true, ctx.isSecure(req)));
    await ctx.stopOwnedPlayback();
    log("INFO", "Credentials changed", { username });
    res.json({ username });
  }));
}
