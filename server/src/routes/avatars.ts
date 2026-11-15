import express from "express";
import { AVATAR_PRESETS, isAvatarPreset } from "../avatar-presets.js";
import { AVATAR_MAX_BYTES, type AvatarStore, publicAvatar, sniffImage, type StoredAvatar } from "../avatars.js";
import { AppError } from "../errors.js";
import { log } from "../logger.js";
import { ForbiddenError } from "../roles.js";
import type { State } from "../store.js";
import { findUserById, switchTargets, USER_ID, type UserRecord } from "../users.js";
import { asyncRoute, type RouteContext } from "./context.js";

export interface AvatarDeps extends RouteContext {
  avatars: AvatarStore;
}

const notFound = () => new AppError("There is no such picture.", "err.avatarNotFound", 404);

/** Raw bytes for the two upload routes only. The limit sits a little above the rule so the
 *  handler, not the parser, is what answers an oversized picture. */
const imageBody = express.raw({ type: ["image/png", "image/jpeg", "image/webp"], limit: AVATAR_MAX_BYTES + 16 * 1024 });

export function registerAvatarRoutes(app: express.Application, deps: AvatarDeps): void {
  const { store, currentUser, avatars } = deps;

  const signedIn = (req: express.Request): UserRecord => {
    const account = currentUser(req);
    if (!account) throw new AppError("Not signed in.", "err.notSignedIn", 401);
    return account;
  };
  const administrator = (req: express.Request): UserRecord => {
    const account = signedIn(req);
    if (account.role !== "admin") throw new ForbiddenError();
    return account;
  };
  const target = (id: string): UserRecord => {
    const user = USER_ID.test(id) ? findUserById(store.users(), id) : undefined;
    if (!user) throw new AppError("That account does not exist.", "err.unknownUser", 404);
    return user;
  };

  const setAvatar = async (userId: string, avatar: StoredAvatar | undefined, actor: UserRecord): Promise<UserRecord> => {
    await store.update((state: State) => {
      const live = findUserById(state.users ?? [], actor.id);
      if (!live || live.disabled || live.secret !== actor.secret) throw new AppError("Not signed in.", "err.notSignedIn", 401);
      if (actor.id !== userId && live.role !== "admin") throw new ForbiddenError();
      let found = false;
      state.users = (state.users ?? []).map((user) => {
        if (user.id !== userId) return user;
        found = true;
        const { avatar: _previous, ...rest } = user;
        return avatar ? { ...rest, avatar } : rest;
      });
      if (!found) throw new AppError("That account does not exist.", "err.unknownUser", 404);
    });
    return findUserById(store.users(), userId)!;
  };

  const choosePreset = async (req: express.Request, userId: string, actor: UserRecord) => {
    const preset: unknown = req.body?.preset;
    if (preset !== null && !isAvatarPreset(preset)) throw new AppError("That picture is not in the set.", "err.invalidRequest", 400);
    const before = findUserById(store.users(), userId);
    const after = await setAvatar(userId, preset === null ? undefined : { preset }, actor);
    // The uploaded file is only dropped once the account no longer points at it.
    if (before?.avatar && "custom" in before.avatar) await avatars.remove(userId);
    return { avatar: publicAvatar(after) ?? null };
  };

  const upload = async (req: express.Request, userId: string, actor: UserRecord) => {
    const body: unknown = req.body;
    if (!Buffer.isBuffer(body) || body.length === 0) throw new AppError("Send a PNG, JPEG or WebP picture.", "err.avatarFormat", 400);
    if (body.length > AVATAR_MAX_BYTES) throw new AppError("The picture is too large.", "err.avatarTooLarge", 413);
    const type = sniffImage(body);
    if (!type) throw new AppError("Send a PNG, JPEG or WebP picture.", "err.avatarFormat", 400);
    await avatars.write(userId, body);
    const after = await setAvatar(userId, { custom: Date.now(), type }, actor);
    log("INFO", "Profile picture uploaded", { actor: actor.username, actorId: actor.id, userId, bytes: body.length });
    return { avatar: publicAvatar(after) ?? null };
  };

  app.get("/api/avatar/presets", (_req, res) => {
    res.setHeader("cache-control", "private, max-age=3600");
    res.json({ presets: AVATAR_PRESETS });
  });

  /** An uploaded picture is shown to the account itself, to an administrator and to the profiles
   *  that may switch to it; to anybody else it does not exist. */
  app.get("/api/avatar/:userId", asyncRoute(async (req, res) => {
    const caller = signedIn(req);
    const id = String(req.params.userId);
    const users = store.users();
    const owner = USER_ID.test(id) ? findUserById(users, id) : undefined;
    const visible = owner !== undefined && (caller.id === owner.id || caller.role === "admin"
      || switchTargets(users, caller.id).some((profile) => profile.id === owner.id));
    if (!owner || !visible || !owner.avatar || !("custom" in owner.avatar)) throw notFound();
    const bytes = await avatars.read(owner.id);
    const type = bytes ? sniffImage(bytes) : undefined;
    if (!bytes || !type) throw notFound();
    res.setHeader("content-type", type);
    res.setHeader("x-content-type-options", "nosniff");
    res.setHeader("content-security-policy", "default-src 'none'; sandbox");
    // The address carries the upload's version, so a new picture has a new address.
    res.setHeader("cache-control", "private, max-age=31536000, immutable");
    res.end(bytes);
  }));

  app.patch("/api/auth/avatar", asyncRoute(async (req, res) => {
    const account = signedIn(req);
    res.json(await choosePreset(req, account.id, account));
  }));
  app.put("/api/auth/avatar/image", imageBody, asyncRoute(async (req, res) => {
    const account = signedIn(req);
    res.json(await upload(req, account.id, account));
  }));
  app.patch("/api/users/:id/avatar", asyncRoute(async (req, res) => {
    const actor = administrator(req);
    res.json(await choosePreset(req, target(String(req.params.id)).id, actor));
  }));
  app.put("/api/users/:id/avatar/image", imageBody, asyncRoute(async (req, res) => {
    const actor = administrator(req);
    res.json(await upload(req, target(String(req.params.id)).id, actor));
  }));
}
