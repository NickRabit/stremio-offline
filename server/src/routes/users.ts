import type express from "express";
import { randomBytes } from "node:crypto";
import { hashPassword } from "../auth.js";
import { AppError } from "../errors.js";
import { log } from "../logger.js";
import { assertStillAdmin } from "../roles.js";
import { ResourceError } from "../media-resources.js";
import type { State } from "../store.js";
import {
  assertAdminRemains, emptyUserData, findUser, findUserById, newUserPermissions, newUserId,
  PASSWORD_MIN, publicUser, USERNAME_MIN,
  type Role, type UserPermissions, type UserRecord,
} from "../users.js";
import { asyncRoute, type RouteContext } from "./context.js";

export interface UsersDeps extends RouteContext {
  /** Everything one account holds, and its unfinished queue work with the partial files
   *  behind them. A deleted account has nothing to come back to, so its jobs are cancelled
   *  rather than paused. */
  deleteUserAccess(userId: string): Promise<void>;
  /** What an edit took away: switching the account off goes entirely, losing the right to
   *  queue pauses only the queue behind it. */
  permissionsChanged(before: UserRecord, after: UserRecord): Promise<void>;
}

/** Take one account's id out of every grant list. Two things need it, for the same reason:
 *  the id no longer belongs there and a list that still carries it cannot be saved again.
 *  Both endpoints send the whole list back and both refuse an id that is not an ordinary
 *  account, so one stale entry makes that library or addon permanently uneditable -- for
 *  every other account too, not only the one that changed. */
const sweepGrants = (state: State, id: string): void => {
  state.libraries = (state.libraries ?? []).map((library) => library.visibleTo?.includes(id)
    ? { ...library, visibleTo: library.visibleTo.filter((entry) => entry !== id) }
    : library);
  state.addons = state.addons.map((addon) => addon.allowedUsers?.includes(id)
    ? { ...addon, allowedUsers: addon.allowedUsers.filter((entry) => entry !== id) }
    : addon);
};

export function registerUsersRoutes(app: express.Application, deps: UsersDeps): void {
  const { store, currentUser, deleteUserAccess, permissionsChanged, stopUserSessions } = deps;

  /** The administrator the request speaks for. The role gate has already refused everybody
   *  else, so a request that names nobody is a bug rather than a case. */
  const actorOf = (req: express.Request): UserRecord => {
    const actor = currentUser(req);
    if (!actor) throw new ResourceError(401, "AUTH_REQUIRED");
    return actor;
  };

  const requireUser = (id: string): UserRecord => {
    const user = findUserById(store.users(), id);
    if (!user) throw new AppError("That account does not exist.", "err.unknownUser", 404);
    return user;
  };

  /** The account as the interface reads it: the public fields and what was granted to it. A
   *  grant list is how an ordinary user gets something, so an administrator's counts stay at
   *  zero rather than counting a list that grants nothing. */
  const view = (user: UserRecord) => ({
    ...publicUser(user),
    libraries: store.libraries().filter((library) => (library.visibleTo ?? []).includes(user.id)).length,
    addons: store.addons().filter((addon) => (addon.allowedUsers ?? []).includes(user.id)).length,
  });

  /** One action, one line naming who did it and to whom, both by name and id: a hash in the
   *  log would make the line impossible to read back later. */
  const audit = (action: string, actor: UserRecord, target: Pick<UserRecord, "id" | "username">, extra: Record<string, unknown> = {}) =>
    log("INFO", action, { actor: actor.username, actorId: actor.id, username: target.username, userId: target.id, ...extra });

  /** Replaces the one record inside the list the state holds now; a whole array read before
   *  the write must never go back over a change that landed in between. */
  const withUser = (state: State, id: string, change: (user: UserRecord) => UserRecord) => {
    state.users = (state.users ?? []).map((user) => user.id === id ? change(user) : user);
  };

  const roleOf = (value: unknown): Role => {
    if (value === "admin" || value === "user") return value;
    throw new AppError("A role is either admin or user.", "err.invalidRequest", 400);
  };

  const flagOf = (value: unknown, name: string): boolean => {
    if (typeof value === "boolean") return value;
    throw new AppError(`${name} is either true or false.`, "err.invalidRequest", 400);
  };

  /** The rights an edit asks for, over the ones the account has now: a body that names one
   *  key leaves the other where it was. */
  const permissionsOf = (value: unknown, fallback: UserPermissions): UserPermissions => {
    if (value === undefined) return fallback;
    const wanted = value as Record<string, unknown>;
    return {
      downloadToLibrary: wanted.downloadToLibrary === undefined ? fallback.downloadToLibrary : flagOf(wanted.downloadToLibrary, "downloadToLibrary"),
      downloadToDevice: wanted.downloadToDevice === undefined ? fallback.downloadToDevice : flagOf(wanted.downloadToDevice, "downloadToDevice"),
    };
  };

  app.get("/api/users", (req, res) => res.json(store.users().map(view)));

  app.post("/api/users", asyncRoute(async (req, res) => {
    const actor = actorOf(req);
    const username = String(req.body?.username ?? "").trim();
    if (username.length < USERNAME_MIN) throw new AppError(`The username needs at least ${USERNAME_MIN} characters.`, "auth.usernameTooShort");
    const password = String(req.body?.password ?? "");
    if (password.length < PASSWORD_MIN) throw new AppError(`The password needs at least ${PASSWORD_MIN} characters.`, "auth.passwordTooShort");
    const record: UserRecord = {
      id: newUserId(store.users().map((user) => user.id)),
      username,
      passwordHash: await hashPassword(password),
      secret: randomBytes(32).toString("hex"),
      role: req.body?.role === undefined ? "user" : roleOf(req.body.role),
      createdAt: new Date().toISOString(),
      permissions: permissionsOf(req.body?.permissions, newUserPermissions()),
      permissionsVersion: 0,
    };
    await store.update((state) => {
      assertStillAdmin(state.users ?? [], actor);
      // Inside the mutator, like every other refusal that reads the list: a name taken in the
      // window between a check before the write and the write itself must not slip through.
      if (findUser(state.users ?? [], username)) {
        throw new AppError("That username is already in use.", "err.usernameTaken", 409);
      }
      state.users = [...(state.users ?? []), record];
      // An account with nothing written for it answers the built-in defaults, which are
      // English: on a Czech install the person would sign in for the first time and find the
      // interface in a language nobody here chose. First run seeds this from the language
      // picked there; an account made in the dashboard takes the same guess from whoever is
      // making it, and can change all three in Settings afterwards.
      const chosen = store.prefs(actor.id).uiLanguage;
      state.userData = {
        ...(state.userData ?? {}),
        [record.id]: { ...emptyUserData(), prefs: { uiLanguage: chosen, audioLanguage: chosen, subtitleLanguage: chosen } },
      };
    });
    audit("Account created", actor, record, { role: record.role });
    res.status(201).json(view(record));
  }));

  app.patch("/api/users/:id", asyncRoute(async (req, res) => {
    const actor = actorOf(req);
    const id = String(req.params.id);
    const before = requireUser(id);
    const role = req.body?.role === undefined ? undefined : roleOf(req.body.role);
    const disabled = req.body?.disabled === undefined ? undefined : flagOf(req.body.disabled, "disabled");
    const permissions = permissionsOf(req.body?.permissions, before.permissions);
    let changed = false;
    await store.update((state) => {
      // Inside the mutator, where the list cannot move under the count: checking before the
      // await would let two concurrent demotions each see two administrators and each take
      // one away.
      if (role === "user") assertAdminRemains(state.users ?? [], { kind: "demote", id });
      if (disabled ?? Boolean(before.disabled)) assertAdminRemains(state.users ?? [], { kind: "disable", id });
      withUser(state, id, (user) => {
        // Switching an account off rotates its secret, so every token it holds stops working
        // for good. Without that the refusal lasts exactly as long as the switch: the old
        // cookie starts answering again the moment somebody switches the account back on, and
        // the device it was taken away from is back in without signing in.
        const cutOff = disabled === true && !user.disabled;
        const next: UserRecord = {
          ...user,
          ...(role ? { role } : {}),
          ...(disabled === undefined ? {} : { disabled }),
          ...(cutOff ? { secret: randomBytes(32).toString("hex"), revoked: {} } : {}),
          permissions,
        };
        changed = next.role !== user.role
          || Boolean(next.disabled) !== Boolean(user.disabled)
          || next.permissions.downloadToLibrary !== user.permissions.downloadToLibrary
          || next.permissions.downloadToDevice !== user.permissions.downloadToDevice;
        return changed ? { ...next, permissionsVersion: user.permissionsVersion + 1 } : user;
      });
      // A promotion makes every grant this account held meaningless -- an administrator sees
      // every library and uses every addon by role -- and leaves the id somewhere it may no
      // longer be written. Sweeping here is what keeps the lists saveable.
      if (role === "admin" && before.role !== "admin") sweepGrants(state, id);
    });
    const after = requireUser(id);
    if (!changed) return res.json(view(after));
    await permissionsChanged(before, after);
    if (role && role !== before.role) audit("Account role changed", actor, after, { from: before.role, to: after.role });
    if (disabled !== undefined && disabled !== Boolean(before.disabled)) audit(disabled ? "Account disabled" : "Account enabled", actor, after);
    if (permissions.downloadToLibrary !== before.permissions.downloadToLibrary || permissions.downloadToDevice !== before.permissions.downloadToDevice) {
      audit("Account permissions changed", actor, after, { permissions: after.permissions });
    }
    res.json(view(after));
  }));

  /** An administrator choosing a password sets one two people know, so the account has to
   *  replace it before it browses or downloads again. */
  app.patch("/api/users/:id/password", asyncRoute(async (req, res) => {
    const actor = actorOf(req);
    const id = String(req.params.id);
    const before = requireUser(id);
    const password = String(req.body?.password ?? "");
    if (password.length < PASSWORD_MIN) throw new AppError(`The new password needs at least ${PASSWORD_MIN} characters.`, "auth.newPasswordTooShort");
    const passwordHash = await hashPassword(password);
    const secret = randomBytes(32).toString("hex");
    await store.update((state) => {
      assertStillAdmin(state.users ?? [], actor);
      withUser(state, id, (user) => ({ ...user, passwordHash, secret, mustChangePassword: true, revoked: {} }));
    });
    // The new secret stops the next request; the sweep reaches the film, the device ticket
    // and the AirPlay grant already in flight on that account's devices. The administrator's
    // own session belongs to another secret and is left alone.
    //
    // Sessions, not the whole account: a reset changes which credential opens the door and
    // takes away no right, so the queue keeps running. Somebody whose password was reset
    // still has every permission they had, and a download to the server is not something
    // they are holding open. Switching the account off is the tool for taking that away.
    await stopUserSessions(id);
    audit("Account password reset", actor, before);
    res.json(view(requireUser(id)));
  }));

  app.delete("/api/users/:id", asyncRoute(async (req, res) => {
    const actor = actorOf(req);
    const id = String(req.params.id);
    if (id === actor.id) throw new AppError("You cannot delete the account you are signed in with.", "err.cannotDeleteSelf", 409);
    const before = requireUser(id);
    await store.update((state) => {
      assertAdminRemains(state.users ?? [], { kind: "delete", id });
      state.users = (state.users ?? []).filter((user) => user.id !== id);
      if (state.userData) delete state.userData[id];
      // A left-behind id is a dangling reference, and ids are never reused.
      sweepGrants(state, id);
    });
    await deleteUserAccess(id);
    audit("Account deleted", actor, before);
    res.status(204).end();
  }));
}
