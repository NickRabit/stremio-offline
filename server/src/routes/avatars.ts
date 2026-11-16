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

const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);

/** The picture is read off the request stream here, not through a body parser: what arrives is
 *  bytes and nothing else, and the count stops the read as soon as it passes the limit. */
async function readImage(req: express.Request): Promise<Buffer> {
  const declared = String(req.headers["content-type"] ?? "").split(";")[0]!.trim().toLowerCase();
  if (!IMAGE_TYPES.has(declared)) throw new AppError("Send a PNG, JPEG or WebP picture.", "err.avatarFormat", 400);
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.byteLength;
    if (size > AVATAR_MAX_BYTES) throw new AppError("The picture is too large.", "err.avatarTooLarge", 413);
    chunks.push(chunk);
  }
  if (size === 0) throw new AppError("Send a PNG, JPEG or WebP picture.", "err.avatarFormat", 400);
  return Buffer.concat(chunks, size);
}

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
    let previous: StoredAvatar | undefined;
    let updated: UserRecord | undefined;
    await store.update((state: State) => {
      const live = findUserById(state.users ?? [], actor.id);
      if (!live || live.disabled || live.secret !== actor.secret) throw new AppError("Not signed in.", "err.notSignedIn", 401);
      if (actor.id !== userId && live.role !== "admin") throw new ForbiddenError();
      if (live.child && avatar && "custom" in avatar) throw new ForbiddenError();
      state.users = (state.users ?? []).map((user) => {
        if (user.id !== userId) return user;
        const { avatar: oldAvatar, ...rest } = user;
        previous = oldAvatar;
        updated = avatar ? { ...rest, avatar } : rest;
        return updated;
      });
      if (!updated) throw new AppError("That account does not exist.", "err.unknownUser", 404);
    });
    if (previous && "custom" in previous) await discard(userId, previous.custom);
    return updated!;
  };

  const discard = async (userId: string, version: string | number) => {
    try {
      await avatars.remove(userId, version);
    } catch (error) {
      log("WARN", "Could not remove profile picture", { userId, version, error });
    }
  };

  const choosePreset = async (req: express.Request, userId: string, actor: UserRecord) => {
    const preset: unknown = req.body?.preset;
    if (preset !== null && !isAvatarPreset(preset)) throw new AppError("That picture is not in the set.", "err.invalidRequest", 400);
    const after = await setAvatar(userId, preset === null ? undefined : { preset }, actor);
    return { avatar: publicAvatar(after) ?? null };
  };

  const upload = async (req: express.Request, userId: string, actor: UserRecord) => {
    const body = await readImage(req);
    const type = sniffImage(body);
    if (!type) throw new AppError("Send a PNG, JPEG or WebP picture.", "err.avatarFormat", 400);
    const version = await avatars.write(userId, body);
    let after: UserRecord;
    try {
      after = await setAvatar(userId, { custom: version, type }, actor);
    } catch (error) {
      await discard(userId, version);
      throw error;
    }
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
    const version = owner.avatar.custom;
    if (req.query.v !== undefined && req.query.v !== String(version)) throw notFound();
    const bytes = await avatars.read(owner.id, version);
    const type = bytes ? sniffImage(bytes) : undefined;
    if (!bytes || !type) throw notFound();
    res.setHeader("content-type", type);
    res.setHeader("x-content-type-options", "nosniff");
    res.setHeader("content-security-policy", "default-src 'none'; sandbox");
    res.setHeader("cache-control", "private, no-store");
    res.end(bytes);
  }));

  app.patch("/api/auth/avatar", asyncRoute(async (req, res) => {
    const account = signedIn(req);
    res.json(await choosePreset(req, account.id, account));
  }));
  app.put("/api/auth/avatar/image", asyncRoute(async (req, res) => {
    const account = signedIn(req);
    res.json(await upload(req, account.id, account));
  }));
  app.patch("/api/users/:id/avatar", asyncRoute(async (req, res) => {
    const actor = administrator(req);
    res.json(await choosePreset(req, target(String(req.params.id)).id, actor));
  }));
  app.put("/api/users/:id/avatar/image", asyncRoute(async (req, res) => {
    const actor = administrator(req);
    res.json(await upload(req, target(String(req.params.id)).id, actor));
  }));
}
