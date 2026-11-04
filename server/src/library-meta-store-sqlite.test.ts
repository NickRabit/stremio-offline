import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { createLibraryFileFacts } from "./library-file-facts.js";
import { LibraryMetaStore } from "./library-meta-store.js";
import type { LibraryEpisodeRecord, LibraryMetaRecord, LibrarySuggestion } from "./library-match.js";
import {
  openAppDatabase,
  StorageError,
  type AppDatabase,
  type Statement,
} from "./storage/app-database.js";

const libA = "lib_aaaaaaaa";
const libB = "lib_bbbbbbbb";

const record = (id: string, name?: string): LibraryMetaRecord => ({
  type: "movie",
  id,
  source: "scan",
  locked: false,
  matchedAt: "2026-01-01T00:00:00.000Z",
  ...(name ? { name } : {}),
});

const suggestion = (id: string, name: string): LibrarySuggestion => ({
  type: "movie",
  id,
  name,
  score: 80,
});

const episode = (name: string): LibraryEpisodeRecord => ({
  season: 1,
  episode: 1,
  name,
});

async function fixture(t: TestContext) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "library-meta-sqlite-"));
  const databases: AppDatabase[] = [];
  const stores: LibraryMetaStore[] = [];
  let database = await openAppDatabase({ dataDir });
  databases.push(database);
  let closed = false;

  const close = async () => {
    if (closed) return;
    closed = true;
    for (const store of stores.reverse()) await store.flush();
    for (const opened of databases.reverse()) {
      try {
        await opened.close();
      } catch (error) {
        if (!(error instanceof StorageError) || error.code !== "broken") throw error;
      }
    }
    await rm(dataDir, { recursive: true, force: true });
  };
  t.after(close);

  return {
    dataDir,
    get database() { return database; },
    async reopen() {
      await database.close();
      database = await openAppDatabase({ dataDir });
      databases.push(database);
      return database;
    },
    store(attached: AppDatabase = database) {
      const store = new LibraryMetaStore(dataDir);
      store.attachDatabase(attached);
      stores.push(store);
      return store;
    },
    async seedLibrary(id: string, meta: Record<string, LibraryMetaRecord>, suggestions: Record<string, LibrarySuggestion> = {}) {
      const dir = path.join(dataDir, "library");
      await mkdir(dir, { recursive: true });
      await writeFile(path.join(dir, `${id}.json`), JSON.stringify({ version: 1, meta, suggestions }, null, 2));
    },
    async seedEpisodes(rows: Record<string, LibraryEpisodeRecord>) {
      const dir = path.join(dataDir, "library");
      await mkdir(dir, { recursive: true });
      await writeFile(path.join(dir, "episodes.json"), JSON.stringify(rows, null, 2));
    },
    close,
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

async function marker(database: AppDatabase, key: string) {
  const row = await database.get<{ value: string }>("SELECT value FROM meta WHERE key = ?", [key]);
  return row ? JSON.parse(row.value) as Record<string, unknown> : undefined;
}

test("library files and episodes import once and restore every view after a restart", async (t) => {
  const fixtureState = await fixture(t);
  const { dataDir, database } = fixtureState;
  await fixtureState.seedLibrary(libA, { "Alpha.mkv": record("tt1", "Alpha") }, { "Alpha folder": suggestion("tt1", "Alpha") });
  await fixtureState.seedLibrary(libB, { "Beta.mkv": record("tt2", "Beta") });
  await fixtureState.seedEpisodes({ "series:tt1:1:1": episode("Pilot") });

  const first = fixtureState.store();
  await first.load();

  assert.equal(first.meta(libA)["Alpha.mkv"]?.id, "tt1");
  assert.equal(first.suggestions(libA)["Alpha folder"]?.score, 80);
  assert.equal(first.episodes()["series:tt1:1:1"]?.name, "Pilot");
  assert.equal(first.qualifiedMeta()[`${libA}/Alpha.mkv`]?.name, "Alpha");
  assert.equal(first.qualifiedMeta()[`${libB}/Beta.mkv`]?.name, "Beta");

  assert.deepEqual(await database.all("SELECT library_id, kind, key FROM library_meta ORDER BY library_id, kind, key"), [
    { library_id: libA, kind: "meta", key: "Alpha.mkv" },
    { library_id: libA, kind: "suggestion", key: "Alpha folder" },
    { library_id: libB, kind: "meta", key: "Beta.mkv" },
  ]);
  assert.deepEqual(await database.all("SELECT key FROM library_episodes"), [{ key: "series:tt1:1:1" }]);
  assert.ok(await marker(database, `domain.libraryMeta.${libA}`));
  assert.ok(await marker(database, `domain.libraryMeta.${libB}`));
  assert.ok(await marker(database, "domain.libraryEpisodes"));
  assert.deepEqual(await readdir(path.join(dataDir, "library")), []);
  const backups = await readdir(path.join(dataDir, "migration-backup"));
  assert.equal(backups.length, 3);
  assert.ok(backups.some((name) => name.startsWith(`library-${libA}-`)));
  assert.ok(backups.some((name) => name.startsWith(`library-${libB}-`)));
  assert.ok(backups.some((name) => name.startsWith("library-episodes-")));

  await fixtureState.seedLibrary(libA, { "Stale.mkv": record("tt9") });
  const restarted = fixtureState.store(await fixtureState.reopen());
  await restarted.load();

  assert.deepEqual(restarted.meta(libA), { "Alpha.mkv": record("tt1", "Alpha") });
  assert.deepEqual(restarted.suggestions(libA), { "Alpha folder": suggestion("tt1", "Alpha") });
  assert.deepEqual(restarted.episodes(), { "series:tt1:1:1": episode("Pilot") });
  assert.deepEqual(restarted.qualifiedMeta(), {
    [`${libA}/Alpha.mkv`]: record("tt1", "Alpha"),
    [`${libB}/Beta.mkv`]: record("tt2", "Beta"),
  });
  assert.deepEqual(await readdir(path.join(dataDir, "library")), [], "a crash leftover beside a marker is moved aside");
});

test("changing one restored episode keeps the others in the database", async (t) => {
  const fixtureState = await fixture(t);
  const first = "series:tt1:1:1";
  const second = "series:tt1:1:2";
  await fixtureState.seedEpisodes({
    [first]: episode("Pilot"),
    [second]: episode("Second"),
  });
  const store = fixtureState.store();
  await store.load();

  const restarted = fixtureState.store(await fixtureState.reopen());
  await restarted.load();
  const changed = { ...episode("Pilot"), name: "Changed" };
  restarted.episodes()[first] = changed;
  await restarted.flush();

  assert.deepEqual(
    await fixtureState.database.all<{ key: string; data: string }>("SELECT key, data FROM library_episodes ORDER BY key"),
    [
      { key: first, data: JSON.stringify(changed) },
      { key: second, data: JSON.stringify(episode("Second")) },
    ],
  );
});

test("metadata loading leaves the file-facts source for its owning store", async (t) => {
  const fixtureState = await fixture(t);
  const libraryId = "lib_00000001";
  const fileFacts = path.join(fixtureState.dataDir, "library", "file-facts.json");
  await fixtureState.seedLibrary(libraryId, { "Film.mkv": record("tt1") });
  await fixtureState.seedEpisodes({ "series:tt1:1:1": episode("Pilot") });
  await mkdir(path.dirname(fileFacts), { recursive: true });
  await writeFile(fileFacts, JSON.stringify({
    version: 1,
    entries: {
      [`${libraryId}/Film.mkv`]: {
        size: 100,
        modified: "2026-01-01T00:00:00.000Z",
        info: null,
        at: 1,
      },
    },
  }));

  await fixtureState.store().load();

  assert.equal((await stat(fileFacts)).isFile(), true);
  const facts = createLibraryFileFacts({
    file: fileFacts,
    database: fixtureState.database,
    now: () => 1,
    probe: async () => undefined,
  });
  await facts.flush();

  assert.ok(Number((await fixtureState.database.get<{ count: number }>("SELECT COUNT(*) AS count FROM file_facts"))?.count) > 0);
  assert.ok(Number(await marker(fixtureState.database, "domain.fileFacts").then((value) => value?.count)) > 0);
});

test("one changed match writes exactly one upsert after the debounce", async (t) => {
  const fixtureState = await fixture(t);
  const batches: Statement[][] = [];
  await fixtureState.seedLibrary(libA, { "Film.mkv": record("tt1") });
  const store = fixtureState.store(observingBatch(fixtureState.database, batches));
  await store.load();
  batches.length = 0;

  const changed = record("tt1", "Renamed");
  await store.update(libA, (file) => { file.meta["Film.mkv"] = changed; });
  assert.equal(batches.length, 0, "the write waits for the debounce");
  await store.flush();

  assert.equal(batches.length, 1);
  assert.equal(batches[0]!.length, 1);
  assert.match(batches[0]![0]!.sql, /^INSERT INTO library_meta /);
  assert.deepEqual(batches[0]![0]!.params, [libA, "meta", "Film.mkv", JSON.stringify(changed)]);
});

test("a debounced write with no changed rows executes nothing", async (t) => {
  const fixtureState = await fixture(t);
  const batches: Statement[][] = [];
  await fixtureState.seedLibrary(libA, { "Film.mkv": record("tt1") });
  const store = fixtureState.store(observingBatch(fixtureState.database, batches));
  await store.load();
  batches.length = 0;

  await store.update(libA, () => undefined);
  await store.flush();

  assert.equal(batches.length, 0);
});

test("an empty first write leaves a marker for the later library rows", async (t) => {
  const fixtureState = await fixture(t);
  const first = fixtureState.store();
  await first.load();
  await first.update(libA, () => undefined);
  await first.flush();

  const match = record("tt1");
  await first.update(libA, (file) => { file.meta["Film.mkv"] = match; });
  await first.flush();

  const restarted = fixtureState.store(await fixtureState.reopen());
  await restarted.load();
  assert.deepEqual(restarted.meta(libA), { "Film.mkv": match });
});

test("a removed suggestion deletes only its row", async (t) => {
  const fixtureState = await fixture(t);
  const batches: Statement[][] = [];
  await fixtureState.seedLibrary(libA, {}, {
    Keep: suggestion("tt1", "Keep"),
    Gone: suggestion("tt2", "Gone"),
  });
  const store = fixtureState.store(observingBatch(fixtureState.database, batches));
  await store.load();
  batches.length = 0;

  await store.update(libA, (file) => { delete file.suggestions.Gone; });
  await store.flush();

  assert.equal(batches.length, 1);
  assert.equal(batches[0]!.length, 1);
  assert.match(batches[0]![0]!.sql, /^DELETE FROM library_meta /);
  assert.deepEqual(batches[0]![0]!.params, [libA, "suggestion", "Gone"]);
  assert.deepEqual(await fixtureState.database.all("SELECT key FROM library_meta WHERE library_id = ?", [libA]), [{ key: "Keep" }]);
});

test("forget deletes only one library's rows and marker", async (t) => {
  const fixtureState = await fixture(t);
  const batches: Statement[][] = [];
  await fixtureState.seedLibrary(libA, { "Alpha.mkv": record("tt1") });
  await fixtureState.seedLibrary(libB, { "Beta.mkv": record("tt2") });
  const store = fixtureState.store(observingBatch(fixtureState.database, batches));
  await store.load();
  batches.length = 0;

  await store.forget(libA);

  assert.equal(batches.length, 1);
  assert.equal(batches[0]!.length, 2);
  assert.deepEqual(await fixtureState.database.all("SELECT library_id, key FROM library_meta"), [
    { library_id: libB, key: "Beta.mkv" },
  ]);
  assert.equal(await marker(fixtureState.database, `domain.libraryMeta.${libA}`), undefined);
  assert.ok(await marker(fixtureState.database, `domain.libraryMeta.${libB}`));
});

test("a damaged library file is copied aside and gets no marker", async (t) => {
  const fixtureState = await fixture(t);
  const batches: Statement[][] = [];
  const file = path.join(fixtureState.dataDir, "library", `${libA}.json`);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, "{ not json");
  const store = fixtureState.store(observingBatch(fixtureState.database, batches));

  await store.load();

  assert.equal(batches.length, 0);
  assert.equal(await marker(fixtureState.database, `domain.libraryMeta.${libA}`), undefined);
  assert.equal(await fixtureState.database.get("SELECT key FROM library_meta WHERE library_id = ?", [libA]), undefined);
  assert.equal((await readdir(path.dirname(file))).filter((name) => name.startsWith(`${libA}.json.damaged-`)).length, 1);
  assert.equal(await readFile(file, "utf8"), "{ not json");
});

test("an unreadable library file stays protected and is never imported or written", async (t) => {
  const fixtureState = await fixture(t);
  const batches: Statement[][] = [];
  const file = path.join(fixtureState.dataDir, "library", `${libA}.json`);
  await mkdir(file, { recursive: true });
  const store = fixtureState.store(observingBatch(fixtureState.database, batches));
  await store.load();

  await store.update(libA, (records) => { records.meta["New.mkv"] = record("tt9"); });
  await store.flush();

  assert.equal(batches.length, 0);
  assert.equal((await stat(file)).isDirectory(), true);
  assert.equal(await marker(fixtureState.database, `domain.libraryMeta.${libA}`), undefined);
  assert.equal(await fixtureState.database.get("SELECT key FROM library_meta WHERE library_id = ?", [libA]), undefined);
});

test("a failing batch keeps the name dirty and a later flush writes it", async (t) => {
  const fixtureState = await fixture(t);
  const batches: Statement[][] = [];
  await fixtureState.seedLibrary(libA, { "Film.mkv": record("tt1") });
  const { database, control } = controllableBatch(fixtureState.database, batches);
  const store = fixtureState.store(database);
  await store.load();
  batches.length = 0;

  const changed = record("tt1", "Renamed");
  await store.update(libA, (file) => { file.meta["Film.mkv"] = changed; });
  control.failNext = true;
  const internal = store as unknown as {
    dirty: Set<string>;
    write(name: string): Promise<void>;
  };
  await internal.write(libA);

  assert.equal(internal.dirty.has(libA), true);
  const stored = await fixtureState.database.get<{ data: string }>(
    "SELECT data FROM library_meta WHERE library_id = ? AND kind = ? AND key = ?",
    [libA, "meta", "Film.mkv"],
  );
  assert.deepEqual(stored ? JSON.parse(stored.data) : undefined, record("tt1"));

  await store.flush();

  assert.equal(internal.dirty.has(libA), false);
  assert.equal(batches.length, 2);
  assert.deepEqual(await fixtureState.database.get("SELECT data FROM library_meta WHERE library_id = ? AND kind = ? AND key = ?", [libA, "meta", "Film.mkv"]), {
    data: JSON.stringify(changed),
  });
});
