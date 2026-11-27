import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { StaleMetaStore } from "./meta-stale.js";
import { openAppDatabase, type AppDatabase } from "./storage/app-database.js";
import type { MetaItem } from "./types.js";

async function databaseFixture(t: TestContext): Promise<AppDatabase> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "stremio-meta-stale-"));
  const database = await openAppDatabase({ dataDir: directory });
  t.after(async () => {
    await database.close();
    await rm(directory, { recursive: true, force: true });
  });
  return database;
}

function observedWrites(database: AppDatabase): { database: AppDatabase; writes: string[] } {
  const writes: string[] = [];
  return {
    writes,
    database: new Proxy(database, {
      get(target, property) {
        if (property === "run" || property === "batch") {
          return (...args: unknown[]) => {
            writes.push(property);
            return (target[property] as (...values: unknown[]) => unknown)(...args);
          };
        }
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }),
  };
}

const film = (name: string): MetaItem => ({ id: "tt1", type: "movie", name });

test("unchanged metadata is not written and changed metadata is written once", async (t) => {
  const database = await databaseFixture(t);
  const initial = new StaleMetaStore();
  initial.attachDatabase(database);
  await initial.remember("movie:tt1", film("First"));

  const observed = observedWrites(database);
  const restarted = new StaleMetaStore();
  restarted.attachDatabase(observed.database);
  await restarted.remember("movie:tt1", film("First"));
  assert.deepEqual(observed.writes, []);

  await restarted.remember("movie:tt1", film("Second"));
  assert.deepEqual(observed.writes, ["run"]);
});

test("metadata survives a new store instance over the same database", async (t) => {
  const database = await databaseFixture(t);
  const first = new StaleMetaStore();
  first.attachDatabase(database);
  await first.remember("series:tt1:artwork", film("Remembered"));

  const restarted = new StaleMetaStore();
  restarted.attachDatabase(database);
  assert.deepEqual(await restarted.get("series:tt1:artwork"), film("Remembered"));
});

test("pruning keeps the newest 5 000 metadata rows", async (t) => {
  const database = await databaseFixture(t);
  await database.batch(Array.from({ length: 5_000 }, (_, index) => ({
    sql: "INSERT INTO meta_stale (key, data, at) VALUES (?, ?, ?)",
    params: [`old-${index}`, JSON.stringify(film(`Old ${index}`)), index + 1],
  })));

  const store = new StaleMetaStore(() => 10_000);
  store.attachDatabase(database);
  await store.remember("newest", film("Newest"));

  assert.equal((await database.get<{ count: number }>("SELECT count(*) AS count FROM meta_stale"))?.count, 5_000);
  assert.equal(await database.get("SELECT key FROM meta_stale WHERE key = ?", ["old-0"]), undefined);
  assert.ok(await database.get("SELECT key FROM meta_stale WHERE key = ?", ["newest"]));
});

test("a key the cap pruned is written again the next time it is remembered", async (t) => {
  const database = await databaseFixture(t);
  let now = 1;
  const store = new StaleMetaStore(() => now);
  store.attachDatabase(database);
  await store.remember("k0", film("Kept in memory"));
  now = 2;
  await database.batch(Array.from({ length: 5_000 }, (_, index) => ({
    sql: "INSERT INTO meta_stale (key, data, at) VALUES (?, ?, ?)",
    params: [`later-${index}`, JSON.stringify(film(`Later ${index}`)), 10 + index],
  })));
  now = 2 + 60 * 60_000;
  await store.remember("newest", film("Newest"));
  assert.equal(await database.get("SELECT key FROM meta_stale WHERE key = ?", ["k0"]), undefined);

  await store.remember("k0", film("Kept in memory"));
  assert.ok(await database.get("SELECT key FROM meta_stale WHERE key = ?", ["k0"]));
});

test("a partial reading is completed from the kept copy and never strips it", async (t) => {
  const store = new StaleMetaStore();
  store.attachDatabase(await databaseFixture(t));
  const full: MetaItem = { ...film("Film"), description: "Plot", cast: ["A", "B"] };
  assert.deepEqual(await store.keep("movie:tt1", full, false), full);
  await store.remember("movie:tt1", full);

  const partial: MetaItem = { ...film("Film"), year: 1999 };
  const shown = await store.keep("movie:tt1", partial, true);
  assert.equal(shown.description, "Plot");
  assert.deepEqual(shown.cast, ["A", "B"]);
  assert.equal(shown.year, 1999);
  await store.remember("movie:tt1", shown);
  const kept = await store.get("movie:tt1");
  assert.equal(kept?.description, "Plot");
  assert.deepEqual(kept?.cast, ["A", "B"]);
});

test("the first usable reading is kept even when a provider failed", async (t) => {
  const store = new StaleMetaStore();
  store.attachDatabase(await databaseFixture(t));
  const reading: MetaItem = { ...film("Film"), description: "Plot" };
  assert.deepEqual(await store.keep("movie:tt1", reading, true), reading);
  await store.remember("movie:tt1", reading);
  assert.equal((await store.get("movie:tt1"))?.description, "Plot");
});
