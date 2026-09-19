import assert from "node:assert/strict";
import { test } from "node:test";
import { hashPassword } from "./auth.js";
import {
  assertAdminRemains, bumpPermissions, emptyUserData, enabledAdmins, envResetApplied, envResetPending, findUser, findUserById,
  migrateUsers, newUserPermissions, newUserId, normalizeUsername, PASSWORD_MIN, PERSONAL_SETTINGS, USER_ID,
  USERNAME_MIN, usersToBump, type MigratableState, type UserRecord,
} from "./users.js";

const user = (over: Partial<UserRecord> = {}): UserRecord => ({
  id: "usr_a1b2c3d4",
  username: "ondra",
  passwordHash: "scrypt$aa$bb",
  secret: "tajemstvi",
  role: "user",
  createdAt: "2026-01-01T00:00:00.000Z",
  permissions: { downloadToLibrary: false, downloadToDevice: true },
  permissionsVersion: 0,
  ...over,
});

const admin = (over: Partial<UserRecord> = {}): UserRecord =>
  user({ id: "usr_00000001", username: "admin", role: "admin", ...over });

test("an id is a fresh usr_ id that never collides with one already in use", () => {
  assert.equal(USERNAME_MIN, 3);
  assert.equal(PASSWORD_MIN, 6);
  const taken = new Set<string>();
  for (let attempt = 0; attempt < 500; attempt += 1) {
    const id = newUserId(taken);
    assert.match(id, USER_ID);
    assert.ok(!taken.has(id), "the loop must retry while the id is taken");
    taken.add(id);
  }
  assert.equal(taken.size, 500);
});

test("two names compare as one whatever their case, their padding or their Unicode form", () => {
  assert.equal(normalizeUsername("  Ondra "), "ondra");
  assert.equal(normalizeUsername("OND\u0158EJ"), "ond\u0159ej");
  assert.equal(normalizeUsername("ondr\u030cej"), "ond\u0159ej", "NFKC folds the decomposed caron");
  assert.equal(normalizeUsername("\uFF2FNDRA"), "ondra");
});

test("a name finds its record whichever spelling was typed", () => {
  const users = [user({ username: "ondra" }), user({ id: "usr_00000002", username: "petr" })];
  assert.equal(findUser(users, "Ondra")?.id, "usr_a1b2c3d4");
  assert.equal(findUser(users, "PETR")?.id, "usr_00000002");
  assert.equal(findUser(users, "nikdo"), undefined);
  assert.equal(findUserById(users, "usr_00000002")?.username, "petr");
  assert.equal(findUserById(users, "usr_deadbeef"), undefined);
});

test("the last enabled administrator cannot be demoted, disabled or deleted", () => {
  for (const change of [
    { kind: "demote", id: "usr_00000001" },
    { kind: "disable", id: "usr_00000001" },
    { kind: "delete", id: "usr_00000001" },
  ] as const) {
    assert.throws(
      () => assertAdminRemains([admin(), user()], change),
      (error: Error & { messageKey?: string; status?: number }) =>
        error.messageKey === "err.lastAdmin" && error.status === 409
        && error.message === "The last administrator cannot be removed.",
      `${change.kind} was allowed to leave the instance without an admin`,
    );
  }
});

test("the same changes pass once a second enabled administrator exists", () => {
  const users = [admin(), admin({ id: "usr_00000002", username: "druhy" }), user()];
  for (const change of [
    { kind: "demote", id: "usr_00000001" },
    { kind: "disable", id: "usr_00000001" },
    { kind: "delete", id: "usr_00000001" },
  ] as const) {
    assertAdminRemains(users, change);
  }
});

test("a disabled administrator does not count as a spare one", () => {
  const users = [admin(), admin({ id: "usr_00000002", username: "vypnuty", disabled: true })];
  assert.throws(() => assertAdminRemains(users, { kind: "demote", id: "usr_00000001" }),
    (error: Error & { messageKey?: string }) => error.messageKey === "err.lastAdmin");
});

test("a change that touches nobody, or a plain user, is not the guard's business", () => {
  const users = [admin(), user()];
  assertAdminRemains(users, { kind: "demote", id: "usr_a1b2c3d4" });
  assertAdminRemains(users, { kind: "delete", id: "usr_deadbeef" });
});

test("only administrators who can still sign in count as administrators", () => {
  const users = [admin(), admin({ id: "usr_00000002", username: "vypnuty", disabled: true }), user({ role: "admin" })];
  assert.deepEqual(enabledAdmins(users).map((entry) => entry.id), ["usr_00000001", "usr_a1b2c3d4"]);
});

test("bumping a permissions list names everyone who left it or entered it", () => {
  assert.deepEqual(usersToBump(["usr_1", "usr_2"], ["usr_2", "usr_3"]), ["usr_1", "usr_2", "usr_3"]);
  assert.deepEqual(usersToBump(undefined, ["usr_3"]), ["usr_3"]);
  assert.deepEqual(usersToBump(["usr_1"], undefined), ["usr_1"]);
  assert.deepEqual(usersToBump(undefined, undefined), []);
});

test("a permission bump touches only the named users and leaves the input array alone", () => {
  const users = [admin(), user(), user({ id: "usr_00000003", username: "petr" })];
  const original = structuredClone(users);
  const bumped = bumpPermissions(users, ["usr_a1b2c3d4"]);
  assert.deepEqual(users, original, "the input array is not the one to change");
  assert.notEqual(bumped, users);
  assert.deepEqual(bumped.map((entry) => entry.permissionsVersion), [0, 1, 0]);
  assert.notEqual(bumped[1], users[1], "the bumped record is a copy");
  assert.equal(bumped[0], users[0], "an untouched record is not copied");
  assert.equal(users[1].permissionsVersion, 0, "the input record keeps its version");
});

test("the recovery ledger decides by comparison, not by hashing again", async () => {
  const id = "usr_a1b2c3d4";
  const password = "noveheslo";
  const hash = await hashPassword(password);
  assert.equal(await envResetPending(undefined, id, password), true, "no ledger, nothing has been applied yet");
  assert.equal(await envResetPending({ userId: "usr_00000002", hash }, id, password), true, "another user's ledger");
  assert.equal(await envResetPending({ userId: id, hash }, id, "jineheslo"), true, "the password changed since");
  assert.equal(await envResetPending(envResetApplied(id, hash), id, password), false, "the same reset is already in");
  assert.deepEqual(envResetApplied(id, hash), { userId: id, hash });
});

test("a new user cannot queue onto the NAS but may save to the device", () => {
  assert.deepEqual(newUserPermissions(), { downloadToLibrary: false, downloadToDevice: true });
  assert.deepEqual(emptyUserData(), { prefs: {}, favorites: [], watchlist: {}, progress: {}, watchedSeries: {} });
});

const singleAccountState = (): MigratableState => ({
  schemaVersion: 2,
  auth: {
    username: "Ondra",
    passwordHash: "scrypt$0f0f$1e1e",
    secret: "tajemstvi",
    isDefault: false,
    revoked: { sid1: 4102444800000 },
  },
  settings: {
    concurrentDownloads: 4,
    uiLanguage: "cs",
    audioLanguage: "cs",
    trackProgress: false,
    catalogTileSize: "large",
    libraryScanPauseOnDownload: true,
  },
  favorites: ["/media/film.mkv"],
  watchlist: { "tt1": { type: "movie", id: "tt1" } },
  progress: { "tt2": { position: 10, duration: 100, title: "Neco" } },
  watchedSeries: { "tt3": { season: 1, episode: 2 } },
});

test("the one account becomes the administrator and its data moves under the user", () => {
  const state = singleAccountState();
  const migration = migrateUsers(state, () => "2026-01-02T03:04:05.000Z");
  assert.equal(migration.migrated, true);
  assert.match(migration.userId ?? "", USER_ID);
  const id = migration.userId ?? "";
  assert.equal(state.users?.length, 1);
  const record = state.users?.[0];
  assert.equal(record?.id, id);
  assert.equal(record?.username, "Ondra", "the record keeps the spelling the user chose");
  assert.equal(record?.passwordHash, "scrypt$0f0f$1e1e", "the password hash is carried over unchanged");
  assert.equal(record?.secret, "tajemstvi", "the secret is carried over unchanged");
  assert.equal(record?.role, "admin");
  assert.deepEqual(record?.permissions, { downloadToLibrary: true, downloadToDevice: true });
  assert.equal(record?.permissionsVersion, 0);
  assert.equal(record?.createdAt, "2026-01-02T03:04:05.000Z");
  assert.deepEqual(record?.revoked, { sid1: 4102444800000 });
  const data = state.userData?.[id];
  assert.deepEqual(data?.favorites, ["/media/film.mkv"]);
  assert.deepEqual(data?.watchlist, { "tt1": { type: "movie", id: "tt1" } });
  assert.deepEqual(data?.progress, { "tt2": { position: 10, duration: 100, title: "Neco" } });
  assert.deepEqual(data?.watchedSeries, { "tt3": { season: 1, episode: 2 } });
  assert.deepEqual(data?.prefs, { uiLanguage: "cs", audioLanguage: "cs", trackProgress: false, catalogTileSize: "large" });
  assert.deepEqual(state.settings, { concurrentDownloads: 4, libraryScanPauseOnDownload: true });
  assert.equal(state.favorites, undefined);
  assert.equal(state.watchlist, undefined);
  assert.equal(state.progress, undefined);
  assert.equal(state.watchedSeries, undefined);
  assert.equal(state.auth, undefined);
  assert.equal(state.schemaVersion, 3);
});

test("a migrated state run again is left byte for byte as it was", () => {
  const state = singleAccountState();
  assert.equal(migrateUsers(state, () => "2026-01-02T03:04:05.000Z").migrated, true);
  const snapshot = structuredClone(state);
  assert.deepEqual(migrateUsers(state, () => "2026-01-02T03:04:05.000Z"), { migrated: false });
  assert.deepEqual(state, snapshot);
});

test("a state with neither an account nor users is left alone", () => {
  const state: MigratableState = { schemaVersion: 1, settings: { uiLanguage: "en", concurrentDownloads: 1 } };
  const snapshot = structuredClone(state);
  assert.deepEqual(migrateUsers(state), { migrated: false });
  assert.deepEqual(state, snapshot);
});

test("an absent personal key is absent from the prefs, and absent maps default to their empty shape", () => {
  const state: MigratableState = {
    auth: { username: "ondra", passwordHash: "scrypt$aa$bb", secret: "tajemstvi" },
    settings: { uiLanguage: "en", concurrentDownloads: 2 },
  };
  const migration = migrateUsers(state, () => "2026-01-02T03:04:05.000Z");
  const data = state.userData?.[migration.userId ?? ""];
  assert.deepEqual(data?.prefs, { uiLanguage: "en" });
  assert.deepEqual(Object.keys(data?.prefs ?? {}).sort(), [...PERSONAL_SETTINGS].filter((key) => key === "uiLanguage"));
  assert.deepEqual(data?.favorites, []);
  assert.deepEqual(data?.watchlist, {});
  assert.deepEqual(data?.progress, {});
  assert.deepEqual(data?.watchedSeries, {});
  assert.equal(state.users?.[0].revoked, undefined, "no revoked sessions to carry over");
});

test("the old admin/admin account is not migrated, so setup still reclaims it", () => {
  const state: MigratableState = {
    schemaVersion: 2,
    auth: { username: "admin", passwordHash: "scrypt$aa$bb", secret: "tajemstvi", isDefault: true },
    settings: { uiLanguage: "cs", concurrentDownloads: 1 },
    progress: { "movie:tt1": { position: 12 } },
  };
  const snapshot = structuredClone(state);
  assert.deepEqual(migrateUsers(state), { migrated: false });
  assert.deepEqual(state, snapshot, "a default account is left for the boot-time removal to throw away");
});
