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
