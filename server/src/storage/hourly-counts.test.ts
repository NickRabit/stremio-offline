import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { openAppDatabase, StorageError } from "./app-database.js";
import { HourlyCounts } from "./hourly-counts.js";

async function fixture(t: TestContext) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "hourly-counts-"));
  const database = await openAppDatabase({ dataDir });
  t.after(async () => {
    try {
      await database.close();
    } catch (error) {
      if (!(error instanceof StorageError) || error.code !== "broken") throw error;
    }
    await rm(dataDir, { recursive: true, force: true });
  });
  return database;
}

test("imported hourly rows and their marker load back together", async (t) => {
  const database = await fixture(t);
  const counts = new HourlyCounts(database, "imageStats");
  const marker = { importedAt: 100, source: "image-stats.json", count: 2 };

  await counts.import([
    { hour: "2026-01-02T03:00:00.000Z", key: "remote.memory", count: 2 },
    { hour: "2026-01-02T04:00:00.000Z", key: "catalog.disk", count: 1 },
  ], marker);

  assert.deepEqual(await counts.load(), [
    { hour: "2026-01-02T03:00:00.000Z", key: "remote.memory", count: 2 },
    { hour: "2026-01-02T04:00:00.000Z", key: "catalog.disk", count: 1 },
  ]);
  assert.deepEqual(await counts.marker(), marker);
});

test("write upserts absolute counts and is idempotent", async (t) => {
  const database = await fixture(t);
  const counts = new HourlyCounts(database, "providerStats");
  const rows = [{ hour: "2026-01-02T03:00:00.000Z", key: "detail", count: 2 }];

  await counts.write(rows, "2025-01-01T00:00:00.000Z");
  await counts.write([...rows], "2025-01-01T00:00:00.000Z");

  assert.deepEqual(await counts.load(), rows);
  await counts.write([{ ...rows[0]!, count: 3 }], "2025-01-01T00:00:00.000Z");
  assert.deepEqual(await counts.load(), [{ ...rows[0]!, count: 3 }]);
});

test("pruning removes only the selected domain's old hours", async (t) => {
  const database = await fixture(t);
  const images = new HourlyCounts(database, "imageStats");
  const providers = new HourlyCounts(database, "providerStats");
  const cutoff = "2026-01-02T00:00:00.000Z";
  await images.import([
    { hour: "2026-01-01T23:00:00.000Z", key: "remote.memory", count: 1 },
    { hour: "2026-01-02T01:00:00.000Z", key: "remote.memory", count: 2 },
  ], {});
  await providers.import([
    { hour: "2026-01-01T23:00:00.000Z", key: "detail", count: 3 },
  ], {});

  await images.write([], cutoff);

  assert.deepEqual(await images.load(), [
    { hour: "2026-01-02T01:00:00.000Z", key: "remote.memory", count: 2 },
  ]);
  assert.deepEqual(await providers.load(), [
    { hour: "2026-01-01T23:00:00.000Z", key: "detail", count: 3 },
  ]);
});
