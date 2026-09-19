import type express from "express";
import { randomBytes } from "node:crypto";
import { clearedCookie, createSession, DECOY_HASH, envCredentials, hashPassword, LoginThrottle, pruneRevoked, REMEMBER_DAYS, secretEquals, sessionCookie, verifyPassword } from "../auth.js";
import { AppError } from "../errors.js";
import { isUiLanguage } from "../language.js";
import { log } from "../logger.js";
import { logoutDenied, RestrictedError } from "../restricted.js";
import type { State } from "../store.js";
import { emptyUserData, findUser, findUserById, newUserId, type UserRecord } from "../users.js";
import { asyncRoute, type RouteContext } from "./context.js";

const logins = new LoginThrottle();

/** Replaces the one record inside the list the state holds now. A whole array read before
 *  the write must never go back over a change that landed in between. */
const withUser = (state: State, id: string, change: (user: UserRecord) => UserRecord) => {
  state.users = (state.users ?? []).map((user) => user.id === id ? change(user) : user);
};

export function registerAuthRoutes(app: express.Application, ctx: RouteContext): void {
  app.get("/api/auth/me", (req, res) => {
    // The language rides along on the one call the sign-in and setup screens can make
    // unauthenticated; without it they would render before knowing which one to use.
    const user = ctx.currentUser(req);
    // Nobody signed in means no personal choice to read, and this release has one account:
    // its language is the best guess for the screen that is about to be shown.
    const language = ctx.store.prefs(user?.id ?? ctx.store.users()[0]?.id).uiLanguage;
    if (ctx.needsSetup()) return res.json({ setup: true, language });
    if (!user) return res.status(401).json({ error: "Not signed in.", messageKey: "err.notSignedIn", language });
    res.json({ username: user.username, role: user.role, language });
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
    const secret = randomBytes(32).toString("hex");
    const id = newUserId(ctx.store.users().map((user) => user.id));
    // The first-run language choice is also the best guess at which audio and
    // subtitles this household wants. Both stay editable in Settings afterwards.
    // A client that sends no language leaves the interface where it is, and the
    // tracks still follow it -- otherwise they would keep the English default.
    const chosen = language ?? ctx.store.prefs(undefined).uiLanguage;
    await ctx.store.update((state) => {
      state.users = [...(state.users ?? []), {
        id, username, passwordHash, secret, role: "admin", createdAt: new Date().toISOString(),
        permissions: { downloadToLibrary: true, downloadToDevice: true }, permissionsVersion: 0,
      }];
      state.userData = {
        ...(state.userData ?? {}),
        [id]: { ...emptyUserData(), prefs: { uiLanguage: chosen, audioLanguage: chosen, subtitleLanguage: chosen } },
      };
    });
    res.setHeader("set-cookie", sessionCookie(createSession(secret, id, Date.now() + REMEMBER_DAYS * 24 * 60 * 60 * 1000), true, ctx.isSecure(req)));
    log("INFO", "Account created on first run", { username, language: chosen });
    res.status(201).json({ username, role: "admin", language: chosen });
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
    const fromEnv = envCredentials();
    const stored = findUser(ctx.store.users(), username);
    // A disabled account is answered exactly like one that is not there at all: the
    // reason is not something a guess may learn.
    const account = stored?.disabled ? undefined : stored;
    // The hash is always computed, even for a name nobody has: a short circuit here
    // would answer an unknown name faster and hand out the list of real ones.
    const passwordMatches = await verifyPassword(password, account?.passwordHash ?? DECOY_HASH);
    const bySettings = passwordMatches && secretEquals(username, account?.username ?? "");
    const byEnv = Boolean(fromEnv) && secretEquals(username, fromEnv?.username ?? "") && secretEquals(password, fromEnv?.password ?? "");
    // The fallback stands beside the stored password, but a session belongs to a record:
    // it signs in as the account ADMIN_USERNAME names.
    const fromEnvUser = byEnv ? findUser(ctx.store.users(), fromEnv!.username) : undefined;
    const signIn = bySettings ? account : fromEnvUser?.disabled ? undefined : fromEnvUser;
    if (!signIn) {
      logins.fail(from);
      log("WARN", "Failed sign-in", { username, from });
      return res.status(401).json({ error: "Wrong username or password.", messageKey: "err.badCredentials" });
    }
    logins.succeed(from);
    const expiresAt = Date.now() + (remember ? REMEMBER_DAYS : 1) * 24 * 60 * 60 * 1000;
    res.setHeader("set-cookie", sessionCookie(createSession(signIn.secret, signIn.id, expiresAt), remember, ctx.isSecure(req)));
    // The column answers "who still uses this account" for an administrator, so it records
    // the sign-in and not every request: writing the state file on each call would be a real
    // cost for a value nobody reads that way.
    await ctx.store.update((state) => withUser(state, signIn.id, (user) => ({ ...user, lastSeenAt: new Date().toISOString() })));
    log("INFO", "Sign-in", { username: signIn.username, remember, viaEnvCredentials: byEnv && !bySettings });
    res.json({ username: signIn.username, role: signIn.role });
  }));
  app.post("/api/auth/logout", asyncRoute(async (req, res) => {
    if (logoutDenied(req.body)) throw new RestrictedError();
    const info = ctx.currentSession(req);
    res.setHeader("set-cookie", clearedCookie());
    if (!info) return res.status(204).end();
    if (req.body?.everywhere) {
      // A new secret invalidates every token issued so far at once.
      const nextSecret = randomBytes(32).toString("hex");
      await ctx.store.update((state) => withUser(state, info.userId, (user) => ({ ...user, secret: nextSecret, revoked: {} })));
      // The secret stops the next request; the sweep reaches the film and the device
      // download that are already running on the other devices.
      await ctx.stopUserSessions(info.userId);
      log("INFO", "Signed out on all devices", { username: findUserById(ctx.store.users(), info.userId)?.username });
    } else {
      await ctx.store.update((state) => withUser(state, info.userId, (user) =>
        ({ ...user, revoked: { ...pruneRevoked(user.revoked), [info.sid]: info.expiresAt } })));
      await ctx.stopOwnedPlayback(info.sid);
      log("INFO", "Sign-out", { username: findUserById(ctx.store.users(), info.userId)?.username });
    }
    res.status(204).end();
  }));
  app.patch("/api/auth/password", asyncRoute(async (req, res) => {
    const account = ctx.currentUser(req);
    if (!account) throw new AppError("No account has been created yet.", "err.noAccount");
    const current = String(req.body.currentPassword ?? "");
    if (!await verifyPassword(current, account.passwordHash)) throw new AppError("The current password is wrong.", "err.wrongCurrentPassword");
    const nextPassword = String(req.body.newPassword ?? "");
    if (nextPassword.length < 6) throw new AppError("The new password needs at least 6 characters.", "auth.newPasswordTooShort");
    const username = String(req.body.username ?? account.username).trim() || account.username;
    const passwordHash = await hashPassword(nextPassword);
    // A new secret invalidates every token issued so far, other devices included.
    const nextSecret = randomBytes(32).toString("hex");
    // The password is the account's own now, so the administrator-set one and the block it
    // carried are gone with it.
    await ctx.store.update((state) => withUser(state, account.id, (user) =>
      ({ ...user, username, passwordHash, secret: nextSecret, revoked: {}, mustChangePassword: false })));
    res.setHeader("set-cookie", sessionCookie(createSession(nextSecret, account.id, Date.now() + REMEMBER_DAYS * 24 * 60 * 60 * 1000), true, ctx.isSecure(req)));
    // Rotating the secret stops the next request; a stream already open on another device
    // keeps reading its resource until the sweep reaches it.
    await ctx.stopUserSessions(account.id);
    log("INFO", "Credentials changed", { username });
    res.json({ username, role: account.role });
  }));
}
