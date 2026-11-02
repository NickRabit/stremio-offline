import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { Store, type State } from "./store.js";
import { openAppDatabase, StorageError, type AppDatabase, type Statement } from "./storage/app-database.js";
import type { UserData, UserRecord } from "./users.js";

const ADA = "usr_00000001";
const BOB = "usr_00000002";
const CREATED = "2026-01-01T00:00:00.000Z";

const user = (id: string, username: string): UserRecord => ({
  id,
  username,
  passwordHash: "scrypt$aa$bb",
  secret: `secret-${id}`,
  role: "admin",
  createdAt: CREATED,
  permissions: { downloadToLibrary: true, downloadToDevice: true },
  permissionsVersion: 0,
});

const personal = (label: string, remote = true): UserData => ({
  prefs: { uiLanguage: "cs", audioLanguage: "cs", subtitleLanguage: "en" },
  favorites: [`lib_00000001/${label} movie.mkv`],
  watchlist: {
    [`movie:${label}`]: { type: "movie", id: label, name: `${label} watch`, addedAt: CREATED },
  },
  progress: {
    [`file:lib_00000001/${label} movie.mkv`]: {
      position: 120,
      duration: 600,
      title: `${label} movie`,
      updatedAt: CREATED,
    },
  },
  watchedSeries: {
    [`series-${label}`]: { name: `${label} show`, season: 1, episode: 2, updatedAt: CREATED },
  },
  ...(remote ? { remoteMedia: { [`remote-${label}`]: { position: 30, duration: 300 } } } : {}),
});

const seededState = (): State => ({
  schemaVersion: 3,
  addons: [],
  settings: {
    concurrentDownloads: 7,
    parallelPerProvider: 1,
    downloadSegments: 2,
    libraryAutoScan: true,
    libraryScanPauseOnDownload: false,
    secureMode: true,
    addonRefreshHours: 24,
    defaultMovieLibrary: "",
    defaultSeriesLibrary: "",
    realDebridToken: "",
    tmdbApiKey: "",
  },
  defaultsInstalled: true,
  users: [user(ADA, "ada"), user(BOB, "bob")],
  userData: {
    [ADA]: personal("Ada"),
    [BOB]: personal("Bob"),
  },
  libraries: [],
});

async function fixture(t: TestContext) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "store-personal-sqlite-"));
  const databases: AppDatabase[] = [];
  let database = await openAppDatabase({ dataDir });
  databases.push(database);
  t.after(async () => {
    for (const opened of databases.reverse()) {
      try {
        await opened.close();
      } catch (error) {
        if (!(error instanceof StorageError) || error.code !== "broken") throw error;
      }
    }
    await rm(dataDir, { recursive: true, force: true });
  });
  return {
    dataDir,
    file: path.join(dataDir, "state.json"),
    get database() { return database; },
    async reopen() {
      await database.close();
      database = await openAppDatabase({ dataDir });
      databases.push(database);
      return database;
    },
    async seed(state: State = seededState()) {
      await writeFile(path.join(dataDir, "state.json"), JSON.stringify(state, null, 2));
    },
  };
}

function observingBatch(database: AppDatabase, batches: Statement[][]): AppDatabase {
  return new Proxy(database, {
    get(target, property) {
      if (property === "batch") {
        return async (statements: Statement[]) => {
          batches.push(statements);
          return await target.batch(statements);
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

function controllableBatch(database: AppDatabase, batches: Statement[][]) {
  const control = { failNext: false };
  const wrapped = new Proxy(database, {
    get(target, property) {
      if (property === "batch") {
        return async (statements: Statement[]) => {
          batches.push(statements);
          if (control.failNext) {
            control.failNext = false;
            throw new Error("database write failed");
          }
          return await target.batch(statements);
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return { database: wrapped, control };
}

function recordingWrites(fail: { value: boolean } = { value: false }) {
  const writes: string[] = [];
  return {
    writes,
    fail,
    hook: async (file: string, data: string) => {
      if (fail.value) throw new Error("state write failed");
      writes.push(data);
      await writeFile(file, data, { mode: 0o600 });
    },
  };
}

async function marker(database: AppDatabase) {
  const row = await database.get<{ value: string }>("SELECT value FROM meta WHERE key = ?", ["domain.personal"]);
  return row ? JSON.parse(row.value) as Record<string, unknown> : undefined;
}

test("hot personal data imports into rows and strips the cold state file", async (t) => {
  const fixtureState = await fixture(t);
  await fixtureState.seed();
  const original = await readFile(fixtureState.file);
  const store = new Store(fixtureState.dataDir);
  store.attachDatabase(fixtureState.database);

  await store.load();

  const imported = await marker(fixtureState.database);
  assert.equal(imported?.source, "state.json");
  assert.equal(imported?.users, 2);
  assert.equal(imported?.rows, 10);
  assert.deepEqual(
    await fixtureState.database.get("SELECT COUNT(*) AS count FROM personal_rows"),
    { count: 10 },
  );
  const backups = await readdir(path.join(fixtureState.dataDir, "migration-backup"));
  assert.equal(backups.length, 1);
  assert.equal(backups[0], `state-${String(imported?.importedAt)}.json`);
  // The copy holds every personal collection of the original, under the same account ids.
  const copy = JSON.parse(await readFile(path.join(fixtureState.dataDir, "migration-backup", backups[0]!), "utf8")) as State;
  const source = JSON.parse(original.toString("utf8")) as State;
  for (const id of [ADA, BOB]) {
    for (const domain of ["favorites", "progress", "watchedSeries", "watchlist", "remoteMedia"] as const) {
      assert.deepEqual(copy.userData?.[id]?.[domain], source.userData?.[id]?.[domain], `${id} ${domain}`);
    }
  }

  const saved = JSON.parse(await readFile(fixtureState.file, "utf8")) as State;
  assert.equal(saved.settings.concurrentDownloads, 7);
  assert.equal(saved.users?.length, 2);
  assert.deepEqual(saved.userData?.[ADA]?.prefs, personal("Ada").prefs);
  for (const id of [ADA, BOB]) {
    for (const domain of ["favorites", "progress", "watchedSeries", "watchlist", "remoteMedia"]) {
      assert.equal(Object.prototype.hasOwnProperty.call(saved.userData?.[id], domain), false);
    }
  }
});

test("a restart restores every hot personal collection from rows", async (t) => {
  const fixtureState = await fixture(t);
  await fixtureState.seed();
  const first = new Store(fixtureState.dataDir);
  first.attachDatabase(fixtureState.database);
  await first.load();
  const expected = {
    [ADA]: structuredClone(first.userData(ADA)),
    [BOB]: structuredClone(first.userData(BOB)),
  };

  const restarted = new Store(fixtureState.dataDir);
  restarted.attachDatabase(await fixtureState.reopen());
  await restarted.load();

  assert.deepEqual(restarted.userData(ADA), expected[ADA]);
  assert.deepEqual(restarted.userData(BOB), expected[BOB]);
});

test("a deferred position change writes one row and leaves state.json alone", async (t) => {
  const fixtureState = await fixture(t);
  await fixtureState.seed();
  const batches: Statement[][] = [];
  const writer = recordingWrites();
  const store = new Store(fixtureState.dataDir, undefined, { writeState: writer.hook });
  store.attachDatabase(observingBatch(fixtureState.database, batches));
  await store.load();
  batches.length = 0;
  writer.writes.length = 0;
  const key = `file:lib_00000001/Ada movie.mkv`;
  const changed = { position: 300, duration: 600, title: "Ada movie", updatedAt: "2026-01-02T00:00:00.000Z" };

  await store.updateLater((state) => { state.userData![ADA]!.progress[key] = changed; }, 60_000);
  await store.flush();

  assert.equal(writer.writes.length, 0);
  assert.equal(batches.length, 1);
  assert.equal(batches[0]!.length, 1);
  assert.match(batches[0]![0]!.sql, /^INSERT INTO personal_rows /);
  assert.deepEqual(batches[0]![0]!.params, [ADA, "progress", key, JSON.stringify(changed)]);
});

test("a cold change writes state.json without touching personal rows", async (t) => {
  const fixtureState = await fixture(t);
  await fixtureState.seed();
  const batches: Statement[][] = [];
  const writer = recordingWrites();
  const store = new Store(fixtureState.dataDir, undefined, { writeState: writer.hook });
  store.attachDatabase(observingBatch(fixtureState.database, batches));
  await store.load();
  batches.length = 0;
  writer.writes.length = 0;

  await store.update((state) => { state.settings.logLevel = "DEBUG"; });

  assert.equal(batches.length, 0);
  assert.equal(writer.writes.length, 1);
  const saved = JSON.parse(writer.writes[0]!) as State;
  assert.equal(saved.settings.logLevel, "DEBUG");
  assert.equal(Object.prototype.hasOwnProperty.call(saved.userData?.[ADA], "progress"), false);
});

test("an update that changes nothing writes neither database rows nor state.json", async (t) => {
  const fixtureState = await fixture(t);
  await fixtureState.seed();
  const batches: Statement[][] = [];
  const writer = recordingWrites();
  const store = new Store(fixtureState.dataDir, undefined, { writeState: writer.hook });
  store.attachDatabase(observingBatch(fixtureState.database, batches));
  await store.load();
  batches.length = 0;
  writer.writes.length = 0;

  await store.update(() => {});

  assert.equal(batches.length, 0);
  assert.equal(writer.writes.length, 0);
});

test("deleting an account deletes all of its personal rows", async (t) => {
  const fixtureState = await fixture(t);
  await fixtureState.seed();
  const batches: Statement[][] = [];
  const store = new Store(fixtureState.dataDir);
  store.attachDatabase(observingBatch(fixtureState.database, batches));
  await store.load();
  batches.length = 0;

  await store.update((state) => {
    state.users = state.users?.filter((entry) => entry.id !== ADA);
    delete state.userData![ADA];
  });

  assert.equal(batches.length, 1);
  assert.equal(batches[0]!.filter((statement) => statement.sql.startsWith("DELETE FROM personal_rows")).length, 5);
  assert.equal(await fixtureState.database.get("SELECT user_id FROM personal_rows WHERE user_id = ?", [ADA]), undefined);
  assert.equal(await fixtureState.database.get("SELECT COUNT(*) AS count FROM personal_rows WHERE user_id = ?", [BOB]).then((row) => row?.count), 5);
});

test("a failed row batch after state.json rejects the update and converges both files on flush", async (t) => {
  const fixtureState = await fixture(t);
  await fixtureState.seed();
  const batches: Statement[][] = [];
  const controlled = controllableBatch(fixtureState.database, batches);
  const store = new Store(fixtureState.dataDir);
  store.attachDatabase(controlled.database);
  await store.load();
  const beforeData = structuredClone(store.userData(ADA));
  const beforeSettings = structuredClone(store.settings());
  const before = await readFile(fixtureState.file, "utf8");
  controlled.control.failNext = true;

  await assert.rejects(store.update((state) => {
    state.userData![ADA]!.progress.changed = { position: 1, duration: 2 };
    state.settings.logLevel = "ERROR";
  }), /database write failed/);

  assert.deepEqual(store.userData(ADA), beforeData);
  assert.deepEqual(store.settings(), beforeSettings);
  await store.flush();
  assert.equal(await readFile(fixtureState.file, "utf8"), before, "state.json is back in step with memory");
  assert.equal(await fixtureState.database.get(
    "SELECT data FROM personal_rows WHERE user_id = ? AND domain = ? AND key = ?",
    [ADA, "progress", "changed"],
  ), undefined);
});

test("a failed state.json write writes no rows at all", async (t) => {
  const fixtureState = await fixture(t);
  await fixtureState.seed();
  const writer = recordingWrites();
  const batches: Statement[][] = [];
  const store = new Store(fixtureState.dataDir, undefined, { writeState: writer.hook });
  store.attachDatabase(observingBatch(fixtureState.database, batches));
  await store.load();
  const beforeData = structuredClone(store.userData(ADA));
  batches.length = 0;
  writer.fail.value = true;

  await assert.rejects(store.update((state) => {
    state.userData![ADA]!.progress.changed = { position: 1, duration: 2 };
    state.settings.logLevel = "ERROR";
  }), /state write failed/);

  assert.deepEqual(store.userData(ADA), beforeData);
  assert.equal(batches.length, 0, "the rows are not touched when state.json could not be written");
});

test("an account deletion interrupted after state.json still ends consistent after a restart", async (t) => {
  const fixtureState = await fixture(t);
  await fixtureState.seed();
  const batches: Statement[][] = [];
  const controlled = controllableBatch(fixtureState.database, batches);
  const store = new Store(fixtureState.dataDir);
  store.attachDatabase(controlled.database);
  await store.load();
  controlled.control.failNext = true;

  await assert.rejects(store.update((state) => {
    state.users = (state.users ?? []).filter((user) => user.id !== BOB);
    delete state.userData![BOB];
  }), /database write failed/);

  // The process stops before the deferred retry: a restart reads state.json without Bob.
  const restarted = new Store(fixtureState.dataDir);
  restarted.attachDatabase(await fixtureState.reopen());
  await restarted.load();
  assert.equal(restarted.users().some((user) => user.id === BOB), false, "the deletion stands");
  // Bob's rows stay behind, unloaded: his id is never reused, so they surface nowhere.
  const onDisk = JSON.parse(await readFile(fixtureState.file, "utf8")) as State;
  assert.equal(Object.keys(onDisk.userData ?? {}).includes(BOB), false);
  assert.ok(Object.keys(restarted.userData(ADA).progress).length > 0, "the other account keeps its rows");
});

test("an account deletion whose state.json write failed keeps the account and all of its rows after a restart", async (t) => {
  const fixtureState = await fixture(t);
  await fixtureState.seed();
  const writer = recordingWrites();
  const store = new Store(fixtureState.dataDir, undefined, { writeState: writer.hook });
  store.attachDatabase(fixtureState.database);
  await store.load();
  const bob = structuredClone(store.userData(BOB));
  writer.fail.value = true;

  await assert.rejects(store.update((state) => {
    state.users = (state.users ?? []).filter((user) => user.id !== BOB);
    delete state.userData![BOB];
  }), /state write failed/);

  const restarted = new Store(fixtureState.dataDir);
  restarted.attachDatabase(await fixtureState.reopen());
  await restarted.load();
  assert.equal(restarted.users().some((user) => user.id === BOB), true);
  assert.deepEqual(restarted.userData(BOB), bob);
});

test("rows win over stale hot fields and the next cold write strips them", async (t) => {
  const fixtureState = await fixture(t);
  await fixtureState.seed();
  const first = new Store(fixtureState.dataDir);
  first.attachDatabase(fixtureState.database);
  await first.load();
  const imported = structuredClone(first.userData(ADA));
  const saved = JSON.parse(await readFile(fixtureState.file, "utf8")) as State;
  saved.userData![ADA] = {
    ...saved.userData![ADA]!,
    favorites: ["stale"],
    progress: { stale: { position: 1 } },
    watchedSeries: { stale: {} },
    watchlist: { stale: {} },
    remoteMedia: { stale: {} },
  };
  await writeFile(fixtureState.file, JSON.stringify(saved, null, 2));

  const restarted = new Store(fixtureState.dataDir);
  restarted.attachDatabase(await fixtureState.reopen());
  await restarted.load();
  assert.deepEqual(restarted.userData(ADA), imported);
  assert.ok((JSON.parse(await readFile(fixtureState.file, "utf8")) as State).userData?.[ADA]?.progress);

  await restarted.update((state) => { state.settings.addonRefreshHours = 8; });
  const stripped = JSON.parse(await readFile(fixtureState.file, "utf8")) as State;
  for (const domain of ["favorites", "progress", "watchedSeries", "watchlist", "remoteMedia"]) {
    assert.equal(Object.prototype.hasOwnProperty.call(stripped.userData?.[ADA], domain), false);
  }
});

test("rows for an account absent from state.userData are kept but not loaded", async (t) => {
  const fixtureState = await fixture(t);
  await fixtureState.seed();
  const first = new Store(fixtureState.dataDir);
  first.attachDatabase(fixtureState.database);
  await first.load();
  await fixtureState.database.run(
    "INSERT INTO personal_rows (user_id, domain, key, data) VALUES (?, ?, ?, ?)",
    ["usr_ffffffff", "progress", "orphan", JSON.stringify({ position: 1 })],
  );

  const restarted = new Store(fixtureState.dataDir);
  restarted.attachDatabase(await fixtureState.reopen());
  await restarted.load();
  await restarted.update((state) => { state.settings.logLevel = "DEBUG"; });

  assert.equal(restarted.users().some((user) => user.id === "usr_ffffffff"), false);
  assert.ok(await fixtureState.database.get("SELECT user_id FROM personal_rows WHERE user_id = ?", ["usr_ffffffff"]));
});

test("JSON mode keeps writing hot personal fields into state.json", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "store-personal-json-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new Store(directory);
  await store.load();

  await store.update((state) => {
    state.users = [user(ADA, "ada")];
    state.userData = { [ADA]: personal("Ada", false) };
  });

  const saved = JSON.parse(await readFile(path.join(directory, "state.json"), "utf8")) as State;
  assert.deepEqual(saved.userData?.[ADA]?.progress, personal("Ada", false).progress);
});

test("a migrated install whose state.json is missing refuses to start and keeps every row", async (t) => {
  const fixtureState = await fixture(t);
  await fixtureState.seed();
  const first = new Store(fixtureState.dataDir);
  first.attachDatabase(fixtureState.database);
  await first.load();
  const before = (await fixtureState.database.all("SELECT user_id FROM personal_rows")).length;
  assert.ok(before > 0);
  const kept = await readFile(fixtureState.file, "utf8");

  // A mis-mounted volume or a deleted file. Carrying on would offer first-run setup.
  await rm(fixtureState.file);
  const restarted = new Store(fixtureState.dataDir);
  restarted.attachDatabase(await fixtureState.reopen());
  await assert.rejects(restarted.load(), /state\.json is missing/);
  assert.equal(restarted.users().length, 0);
  await assert.rejects(readFile(fixtureState.file, "utf8"), { code: "ENOENT" }, "no new state is written");
  assert.equal((await fixtureState.database.all("SELECT user_id FROM personal_rows")).length, before);

  // Putting the file back is all it takes.
  await writeFile(fixtureState.file, kept);
  const restored = new Store(fixtureState.dataDir);
  restored.attachDatabase(await fixtureState.reopen());
  await restored.load();
  assert.ok(Object.keys(restored.userData(ADA).progress).length > 0);
});

test("a first start without state.json writes no file and no marker, and a later start imports", async (t) => {
  const fixtureState = await fixture(t);
  const store = new Store(fixtureState.dataDir);
  store.attachDatabase(fixtureState.database);
  await store.load();

  await assert.rejects(readFile(fixtureState.file, "utf8"), { code: "ENOENT" });
  assert.equal(await marker(fixtureState.database), undefined, "nothing is recorded for a state that was never read");

  // A state.json that appears afterwards (a restored backup) is imported on the next start.
  await fixtureState.seed();
  const restarted = new Store(fixtureState.dataDir);
  restarted.attachDatabase(await fixtureState.reopen());
  await restarted.load();
  assert.ok(await marker(fixtureState.database));
  assert.ok(Object.keys(restarted.userData(ADA).progress).length > 0);
});

test("a pre-accounts state whose strip write fails keeps its account id and data on the next start", async (t) => {
  const fixtureState = await fixture(t);
  await writeFile(fixtureState.file, JSON.stringify({
    addons: [], settings: {}, defaultsInstalled: true,
    auth: { username: "ada", passwordHash: "scrypt$00$00", secret: "secret-secret-secret" },
    favorites: ["lib_00000001/Film.mkv"],
    progress: { "file:lib_00000001/Film.mkv": { position: 60, duration: 600, title: "Film", updatedAt: CREATED } },
  }, null, 2));
  let writes = 0;
  const failing = new Store(fixtureState.dataDir, undefined, {
    writeState: async (file, data) => {
      writes += 1;
      // The account migration is saved; the strip that follows the row import fails.
      if (writes === 2) throw new Error("state write failed");
      await writeFile(file, data, { mode: 0o600 });
    },
  });
  failing.attachDatabase(fixtureState.database);
  await assert.rejects(failing.load(), /state write failed/);
  const id = failing.users()[0]!.id;

  const restarted = new Store(fixtureState.dataDir);
  restarted.attachDatabase(await fixtureState.reopen());
  await restarted.load();
  assert.equal(restarted.users()[0]?.id, id, "the account keeps the id its rows are keyed by");
  assert.deepEqual(restarted.userData(id).favorites, ["lib_00000001/Film.mkv"]);
  assert.ok(restarted.userData(id).progress["file:lib_00000001/Film.mkv"]);
});

test("restoring the migration-backup copy of a pre-accounts state reattaches its rows", async (t) => {
  const fixtureState = await fixture(t);
  await writeFile(fixtureState.file, JSON.stringify({
    addons: [], settings: {}, defaultsInstalled: true,
    auth: { username: "ada", passwordHash: "scrypt$00$00", secret: "secret-secret-secret" },
    favorites: ["lib_00000001/Film.mkv"],
  }, null, 2));
  // The first boot migrates the account and saves it; the second finds it claimed and imports.
  const first = new Store(fixtureState.dataDir);
  first.attachDatabase(fixtureState.database);
  await first.load();
  const second = new Store(fixtureState.dataDir);
  second.attachDatabase(await fixtureState.reopen());
  await second.load();
  const id = second.users()[0]!.id;
  assert.ok(await marker(fixtureState.database));

  const [copy] = await readdir(path.join(fixtureState.dataDir, "migration-backup"));
  await writeFile(fixtureState.file, await readFile(path.join(fixtureState.dataDir, "migration-backup", copy!), "utf8"));
  const restored = new Store(fixtureState.dataDir);
  restored.attachDatabase(await fixtureState.reopen());
  await restored.load();
  assert.equal(restored.users()[0]?.id, id);
  assert.deepEqual(restored.userData(id).favorites, ["lib_00000001/Film.mkv"]);
});

test("unclaimed top-level personal data keeps the store in state.json until an account owns it", async (t) => {
  const fixtureState = await fixture(t);
  await writeFile(fixtureState.file, JSON.stringify({
    addons: [], settings: {}, defaultsInstalled: true,
    favorites: ["lib_00000001/Film.mkv"],
    progress: { "file:lib_00000001/Film.mkv": { position: 60, duration: 600, title: "Film", updatedAt: CREATED } },
  }, null, 2));
  const store = new Store(fixtureState.dataDir);
  store.attachDatabase(fixtureState.database);
  await store.load();
  assert.equal(await marker(fixtureState.database), undefined, "nothing is imported while no account owns the data");

  const created = await store.adoptEnvCredentials({ username: "ada", password: "secret-secret" });
  assert.ok(created);
  const id = store.users()[0]!.id;
  const saved = JSON.parse(await readFile(fixtureState.file, "utf8")) as State;
  assert.deepEqual(saved.userData?.[id]?.favorites, ["lib_00000001/Film.mkv"], "the claim lands in state.json in one write");

  const restarted = new Store(fixtureState.dataDir);
  restarted.attachDatabase(await fixtureState.reopen());
  await restarted.load();
  assert.ok(await marker(fixtureState.database));
  assert.deepEqual(restarted.userData(id).favorites, ["lib_00000001/Film.mkv"]);
  assert.ok(restarted.userData(id).progress["file:lib_00000001/Film.mkv"]);
});

test("two watchlist keys that differ only after a NUL stay two rows", async (t) => {
  const fixtureState = await fixture(t);
  const state = seededState();
  state.userData![ADA]!.watchlist = {
    "movie:tt123": { type: "movie", id: "tt123", name: "One", addedAt: CREATED },
    "movie:tt123\u0000alt": { type: "movie", id: "tt123\u0000alt", name: "Two", addedAt: CREATED },
  };
  await fixtureState.seed(state);
  const store = new Store(fixtureState.dataDir);
  store.attachDatabase(fixtureState.database);
  await store.load();
  assert.equal((await fixtureState.database.all("SELECT key FROM personal_rows WHERE user_id = ? AND domain = 'watchlist'", [ADA])).length, 2);

  await store.update((next) => { delete next.userData![ADA]!.watchlist["movie:tt123\u0000alt"]; });
  const restarted = new Store(fixtureState.dataDir);
  restarted.attachDatabase(await fixtureState.reopen());
  await restarted.load();
  assert.deepEqual(Object.keys(restarted.userData(ADA).watchlist), ["movie:tt123"]);
});

test("a change to both files interrupted before the rows landed is completed at the next start", async (t) => {
  const fixtureState = await fixture(t);
  await fixtureState.seed();
  const batches: Statement[][] = [];
  const controlled = controllableBatch(fixtureState.database, batches);
  const store = new Store(fixtureState.dataDir);
  store.attachDatabase(controlled.database);
  await store.load();
  controlled.control.failNext = true;

  // Like forgetting a library: the cold state changes and a favourite goes with it.
  await assert.rejects(store.update((state) => {
    state.settings.logLevel = "ERROR";
    state.userData![ADA]!.favorites = [];
  }), /database write failed/);

  // The process stops before the deferred retry. The next start finishes the change.
  const restarted = new Store(fixtureState.dataDir);
  restarted.attachDatabase(await fixtureState.reopen());
  await restarted.load();
  assert.equal(restarted.settings().logLevel, "ERROR");
  assert.deepEqual(restarted.userData(ADA).favorites, []);
  const favorites = await fixtureState.database.get<{ data: string }>(
    "SELECT data FROM personal_rows WHERE user_id = ? AND domain = 'favorites'", [ADA],
  );
  assert.equal(favorites?.data, "[]");

  await restarted.update((state) => { state.settings.logLevel = "INFO"; });
  const saved = JSON.parse(await readFile(fixtureState.file, "utf8")) as Record<string, unknown>;
  assert.equal("personalPending" in saved, false, "the journal is gone once replayed");
});

test("a change to only the rows writes no journal and no state.json", async (t) => {
  const fixtureState = await fixture(t);
  await fixtureState.seed();
  const writer = recordingWrites();
  const store = new Store(fixtureState.dataDir, undefined, { writeState: writer.hook });
  store.attachDatabase(fixtureState.database);
  await store.load();
  const writesBefore = writer.writes.length;
  await store.update((state) => { state.userData![ADA]!.favorites = ["lib_00000001/Other.mkv"]; });
  assert.equal(writer.writes.length, writesBefore);
});
