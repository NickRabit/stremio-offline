import { randomBytes } from "node:crypto";
import { verifyPassword } from "./auth.js";
import { AppError } from "./errors.js";

export type Role = "admin" | "user";

export interface UserPermissions {
  /** Queue a download onto the NAS. A new user: false. */
  downloadToLibrary: boolean;
  /** Save allowed content to the device at the keyboard. A new user: true. */
  downloadToDevice: boolean;
}

export interface UserRecord {
  /** `usr_` + 8 lowercase hex. Never derived from the name, never reused. */
  id: string;
  username: string;
  passwordHash: string;
  /** Signs only this user's sessions, so one password change logs out one person. */
  secret: string;
  role: Role;
  /** Cannot sign in. The record, its data and its finished files are kept. */
  disabled?: boolean;
  /** Set when an administrator chose the password. Until the user replaces it,
   *  the server allows only the account endpoints. */
  mustChangePassword?: boolean;
  createdAt: string;
  lastSeenAt?: string;
  /** Revoked sessions by identifier; the value is when they would have expired. */
  revoked?: Record<string, number>;
  permissions: UserPermissions;
  /** Bumped by every change to role, permissions, disabled, or to any
   *  visibleTo / allowedUsers list this user enters or leaves. A request
   *  captures it and re-checks it before it issues a resource. */
  permissionsVersion: number;
}

/** The personal half of the state, one record per user. */
export interface UserData {
  /** The personal slice of Settings. A missing key falls back to the instance default. */
  prefs: Record<string, unknown>;
  /** Per-user addon priority, addon keys only. Unknown keys are ignored and
   *  missing ones sort after, in the global order. */
  addonOrder?: string[];
  /** Per-account library / queue browse chrome. Shape pinned in views.ts. */
  views?: Record<string, unknown>;
  favorites: string[];
  watchlist: Record<string, unknown>;
  progress: Record<string, unknown>;
  watchedSeries: Record<string, unknown>;
}

/** The account as anything outside the process may see it. The hash is what a password is
 *  checked against, the secret signs that account's sessions and the ledger says which of
 *  them were withdrawn: none of the three leaves the server. */
export interface PublicUser {
  id: string;
  username: string;
  role: Role;
  disabled: boolean;
  mustChangePassword: boolean;
  createdAt: string;
  lastSeenAt?: string;
  permissions: UserPermissions;
}

export function publicUser(record: UserRecord): PublicUser {
  return {
    id: record.id,
    username: record.username,
    role: record.role,
    disabled: Boolean(record.disabled),
    mustChangePassword: Boolean(record.mustChangePassword),
    createdAt: record.createdAt,
    ...(record.lastSeenAt ? { lastSeenAt: record.lastSeenAt } : {}),
    permissions: { ...record.permissions },
  };
}

export const USER_ID = /^usr_[0-9a-f]{8}$/;

/** Mirrors `newLibraryId()` in libraries.ts. Collision-checked against the ids
 *  already in use, because 32 bits is small enough to be worth one loop. */
export function newUserId(taken?: Iterable<string>): string {
  const used = new Set(taken);
  let id = `usr_${randomBytes(4).toString("hex")}`;
  while (used.has(id)) id = `usr_${randomBytes(4).toString("hex")}`;
  return id;
}

/** NFKC, trimmed, lowercased. Used only to compare two names, never to store
 *  one: the record keeps the spelling the user chose. */
export function normalizeUsername(value: string): string {
  return value.normalize("NFKC").trim().toLowerCase();
}

export function findUser(users: UserRecord[], username: string): UserRecord | undefined {
  const wanted = normalizeUsername(username);
  return users.find((user) => normalizeUsername(user.username) === wanted);
}

export function findUserById(users: UserRecord[], id: string): UserRecord | undefined {
  return users.find((user) => user.id === id);
}

export const USERNAME_MIN = 3;
export const PASSWORD_MIN = 6;

export const enabledAdmins = (users: UserRecord[]): UserRecord[] =>
  users.filter((user) => user.role === "admin" && !user.disabled);

export type AdminChange =
  | { kind: "demote"; id: string }
  | { kind: "disable"; id: string }
  | { kind: "delete"; id: string };

/**
 * Throws `AppError("The last administrator cannot be removed.", "err.lastAdmin", 409)`
 * when the change would leave the instance with no enabled administrator. Pure: it
 * decides, it does not apply.
 *
 * This is only half of the guarantee. Counting the admins and then `await
 * store.update(...)` leaves a window in which two concurrent requests each see two
 * admins and each demote one. The caller must invoke this inside the synchronous
 * mutator it passes to `store.update()`, where the state cannot change under it.
 */
export function assertAdminRemains(users: UserRecord[], change: AdminChange): void {
  const target = findUserById(users, change.id);
  if (!target || target.role !== "admin" || target.disabled) return;
  if (enabledAdmins(users).length > 1) return;
  throw new AppError("The last administrator cannot be removed.", "err.lastAdmin", 409);
}

/** Every user named in either list, so a user just removed is bumped too —
 *  they are the ones whose in-flight requests most need to fail their re-check. */
export function usersToBump(before: string[] | undefined, after: string[] | undefined): string[] {
  return [...new Set([...(before ?? []), ...(after ?? [])])].sort();
}

/** The ids a grant edit has to carry over untouched: the accounts that are administrators
 *  now. Their entry grants nothing -- the role already sees every library and uses every
 *  addon -- so it lies dormant until the account is demoted, and comes back with it. The
 *  dashboard hides the grant panes for an administrator and so never sends those ids, so an
 *  edit that took the request's list literally would throw the dormant grants away. */
export function dormantGrants(users: UserRecord[], held: string[] | undefined): string[] {
  return (held ?? []).filter((id) => findUserById(users, id)?.role === "admin");
}

/** Returns a new array with `permissionsVersion` incremented on the named users. */
export function bumpPermissions(users: UserRecord[], ids: Iterable<string>): UserRecord[] {
  const named = new Set(ids);
  return users.map((user) => named.has(user.id) ? { ...user, permissionsVersion: user.permissionsVersion + 1 } : user);
}

export interface EnvReset { userId: string; hash: string }

/**
 * Whether `ADMIN_PASSWORD_RESET` names a reset that has not been applied yet.
 *
 * A variable left in the Docker configuration must not reset the password on
 * every restart, so the value that was acted on is recorded. It is recorded as
 * a scrypt hash and compared with `verifyPassword`, never by hashing the value
 * again: `hashPassword` draws a fresh salt each call, so hash-versus-hash never
 * matches and the reset would fire every boot. A fast digest is not an option
 * either — it would put an offline-verifiable fingerprint of a live password in
 * state.json next to the scrypt hash that was made slow on purpose.
 */
export async function envResetPending(
  ledger: EnvReset | undefined,
  targetUserId: string,
  envPassword: string,
): Promise<boolean> {
  if (!ledger || ledger.userId !== targetUserId) return true;
  return !await verifyPassword(envPassword, ledger.hash);
}

/** The ledger entry to store beside a password that has just been set. Takes the
 *  hash already computed for `passwordHash` rather than deriving a second one. */
export const envResetApplied = (userId: string, passwordHash: string): EnvReset =>
  ({ userId, hash: passwordHash });

/** The parts of the persisted state this migration reads and writes. Declared
 *  here rather than imported, so this module stays free of a store.ts import. */
export interface MigratableState {
  schemaVersion?: number;
  auth?: { username: string; passwordHash: string; secret: string; isDefault?: boolean; revoked?: Record<string, number> };
  users?: UserRecord[];
  userData?: Record<string, UserData>;
  envReset?: EnvReset;
  settings?: Record<string, unknown>;
  favorites?: string[];
  watchlist?: Record<string, unknown>;
  progress?: Record<string, unknown>;
  watchedSeries?: Record<string, unknown>;
}

/** The keys of Settings that belong to the person rather than the instance. */
export const PERSONAL_SETTINGS = [
  "uiLanguage", "audioLanguage", "subtitleLanguage", "downloadTitleLanguage",
  "mergeByName", "streamSort", "trackProgress", "showResumeRow",
  "catalogTileSize", "libraryTileSize", "catalogTileShape", "libraryTileShape",
] as const;

export interface UserMigration { migrated: boolean; userId?: string }

/** Turns a single-account state into the accounts shape, in place.
 *  Idempotent: a state that already has `users` is left untouched.
 *
 *  A state with neither `auth` nor `users` is an install running only on
 *  `ADMIN_USERNAME` / `ADMIN_PASSWORD`; creating its record needs those
 *  credentials and belongs to the wiring task, so it is left alone here.
 *
 *  An `isDefault` account is the old admin/admin, which the server has always
 *  thrown away on boot so the owner is forced through setup. It must not be
 *  migrated: this runs inside `store.load()`, before that removal, so carrying
 *  it across would turn a password everyone knows into a real administrator. */
export function migrateUsers(state: MigratableState, now: () => string = () => new Date().toISOString()): UserMigration {
  if (state.users || !state.auth || state.auth.isDefault) return { migrated: false };
  const auth = state.auth;
  const id = newUserId(Object.keys(state.userData ?? {}));
  state.users = [{
    id,
    username: auth.username,
    passwordHash: auth.passwordHash,
    secret: auth.secret,
    role: "admin",
    createdAt: now(),
    ...(auth.revoked ? { revoked: auth.revoked } : {}),
    // Both true only so the record is well-formed: the role is what actually
    // grants an administrator everything.
    permissions: { downloadToLibrary: true, downloadToDevice: true },
    permissionsVersion: 0,
  }];
  claimLegacyData(state, id);
  delete state.auth;
  state.schemaVersion = 3;
  return { migrated: true, userId: id };
}

/** Moves what an install kept before accounts -- the favourites, the watchlist, the progress,
 *  the series markers and the personal half of the settings -- onto one account.
 *
 *  Two paths arrive here. An install with a stored password is migrated above. An install
 *  configured only with `ADMIN_USERNAME` and `ADMIN_PASSWORD` has no `auth` block to migrate,
 *  so it used to be given an account and nothing else: its history stayed at the top level in
 *  a shape nothing reads any more, and its language fell back to the built-in English. */
export function claimLegacyData(state: MigratableState, id: string): void {
  const settings = state.settings ?? {};
  const prefs: Record<string, unknown> = {};
  for (const key of PERSONAL_SETTINGS) {
    if (Object.prototype.hasOwnProperty.call(settings, key)) prefs[key] = settings[key];
  }
  const held = state.userData?.[id];
  state.userData = {
    ...(state.userData ?? {}),
    [id]: {
      prefs: { ...prefs, ...(held?.prefs as Record<string, unknown> | undefined) },
      favorites: held?.favorites?.length ? held.favorites : state.favorites ?? [],
      watchlist: Object.keys(held?.watchlist ?? {}).length ? held!.watchlist : state.watchlist ?? {},
      progress: Object.keys(held?.progress ?? {}).length ? held!.progress : state.progress ?? {},
      watchedSeries: Object.keys(held?.watchedSeries ?? {}).length ? held!.watchedSeries : state.watchedSeries ?? {},
    } as UserData,
  };
  delete state.favorites;
  delete state.watchlist;
  delete state.progress;
  delete state.watchedSeries;
  if (state.settings) {
    const remaining: Record<string, unknown> = { ...state.settings };
    for (const key of PERSONAL_SETTINGS) delete remaining[key];
    state.settings = remaining;
  }
}

/** Applies one change to every account's rows.
 *
 *  A file that is renamed, moved or deleted is not one person's. Each account stores its own
 *  favourites and progress against the same path, so a sweep that reaches only one of them --
 *  which is what falling back to "the first account" amounts to -- leaves everybody else
 *  pointing at something that is no longer there. */
export function forEachUserData(
  state: { users?: UserRecord[]; userData?: Record<string, UserData> },
  mutate: (data: UserData) => void,
): void {
  for (const user of state.users ?? []) {
    const data = state.userData?.[user.id] ?? emptyUserData();
    mutate(data);
    state.userData = { ...(state.userData ?? {}), [user.id]: data };
  }
}

export const newUserPermissions = (): UserPermissions =>
  ({ downloadToLibrary: false, downloadToDevice: true });

export const emptyUserData = (): UserData =>
  ({ prefs: {}, favorites: [], watchlist: {}, progress: {}, watchedSeries: {} });
