import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { renameWithRetry } from "./fs-retry.js";
import { ImageProxy, imageId } from "./images.js";
import { flushLog, initLogger, readLog } from "./logger.js";
import {
  openAppDatabase,
  StorageError,
  type AppDatabase,
  type Statement,
} from "./storage/app-database.js";

process.env.LOG_STDOUT = "0";
await initLogger(await mkdtemp(path.join(os.tmpdir(), "stremio-images-sqlite-log-")));

const MiB = 1024 * 1024;
const IMAGE_TYPE = "image/png";

async function fixture(t: TestContext) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "stremio-images-sqlite-"));
  const imageDir = path.join(dataDir, "images");
  await mkdir(imageDir);
  let database = await openAppDatabase({ dataDir });
  t.after(async () => {
    try {
      await database.close();
    } catch (error) {
      if (!(error instanceof StorageError) || error.code !== "broken") throw error;
    }
    await rm(dataDir, { recursive: true, force: true });
  });
  return {
    dataDir,
    imageDir,
    get database() { return database; },
    async reopen() {
      await database.close();
      database = await openAppDatabase({ dataDir });
      return database;
    },
  };
}

function proxyFor(dataDir: string, database: AppDatabase) {
  return new ImageProxy(
    path.join(dataDir, "images"),
    MiB,
    0,
    async () => new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": IMAGE_TYPE } }),
    0,
    Date.now,
    0,
    renameWithRetry,
    undefined,
    database,
  );
}

function observingBatch(database: AppDatabase, seen: Statement[][]): AppDatabase {
  return new Proxy(database, {
    get(target, property) {
      if (property === "batch") {
        return async (statements: Statement[]) => {
          seen.push(statements);
          return await target.batch(statements);
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

async function marker(database: AppDatabase) {
  const row = await database.get<{ value: string }>("SELECT value FROM meta WHERE key = ?", ["domain.images"]);
  return row ? JSON.parse(row.value) as unknown : undefined;
}

test("an existing index is imported atomically and moved to the migration backup", async (t) => {
  const { dataDir, imageDir, database } = await fixture(t);
  const wideUrl = "https://cdn.example/wide.jpg";
  const cachedUrl = "https://cdn.example/cached.png";
  const missingUrl = "https://cdn.example/missing.png";
  const wideId = imageId(`1920\n${wideUrl}`);
  const cachedId = imageId(cachedUrl);
  const missingId = imageId(missingUrl);
  await writeFile(path.join(imageDir, `${cachedId}.png`), Buffer.from([1, 2, 3, 4]));
  await writeFile(path.join(imageDir, "index.json"), JSON.stringify({
    [wideId]: { url: wideUrl, width: 1920, at: 100 },
    [cachedId]: { url: cachedUrl, width: 1234, ext: "png", bytes: 4, at: 101 },
    [missingId]: { url: missingUrl, ext: "png", bytes: 400, at: 102 },
  }));

  const batches: Statement[][] = [];
  const proxy = proxyFor(dataDir, observingBatch(database, batches));
  await proxy.load();

  assert.equal(batches.length, 1);
  assert.equal(batches[0]!.length, 4, "three rows and the marker commit together");
  const recorded = await marker(database) as { importedAt: number; source: string; count: number };
  assert.equal(recorded.source, "index.json");
  assert.equal(recorded.count, 3);
  assert.ok(Number.isInteger(recorded.importedAt));
  const rows = await database.all<{
    id: string; url: string; width: number | null; ext: string | null; bytes: number | null; at: number;
  }>("SELECT id, url, width, ext, bytes, at FROM image_sources ORDER BY id");
  assert.deepEqual(rows, [
    { id: cachedId, url: cachedUrl, width: null, ext: "png", bytes: 4, at: 101 },
    { id: missingId, url: missingUrl, width: null, ext: null, bytes: null, at: 102 },
    { id: wideId, url: wideUrl, width: 1920, ext: null, bytes: null, at: 100 },
  ].sort((left, right) => left.id.localeCompare(right.id)));
  assert.equal(proxy.proxied(wideUrl, 1920), `/api/image/${wideId}`);
  assert.equal(proxy.proxied(cachedUrl), `/api/image/${cachedId}`);
  assert.equal(proxy.proxied(missingUrl), `/api/image/${missingId}`);
  await assert.rejects(stat(path.join(imageDir, "index.json")), { code: "ENOENT" });
  const backups = await readdir(path.join(dataDir, "migration-backup"));
  assert.equal(backups.length, 1);
  assert.match(backups[0]!, /^images-index-\d+\.json$/);
  if (process.platform !== "win32") {
    assert.equal((await stat(path.join(dataDir, "migration-backup"))).mode & 0o777, 0o700);
  }
});

test("a restart loads image rows instead of a later index.json", async (t) => {
  const { dataDir, database: firstDatabase, reopen } = await fixture(t);
  const keptUrl = "https://cdn.example/kept.png";
  const keptId = imageId(keptUrl);
  await writeFile(path.join(dataDir, "images", "index.json"), JSON.stringify({
    [keptId]: { url: keptUrl, at: 100 },
  }));
  const first = proxyFor(dataDir, firstDatabase);
  await first.load();
  await first.flush();

  const decoyUrl = "https://cdn.example/decoy.png";
  const decoyId = imageId(decoyUrl);
  await writeFile(path.join(dataDir, "images", "index.json"), JSON.stringify({
    [decoyId]: { url: decoyUrl, at: 200 },
  }));
  const database = await reopen();
  const second = proxyFor(dataDir, database);
  await second.load();

  assert.equal(second.original(`/api/image/${keptId}`), keptUrl);
  assert.equal(second.original(`/api/image/${decoyId}`), undefined);
  assert.equal(await second.source(decoyId), undefined);
});

test("a touch writes exactly one changed row", async (t) => {
  const { dataDir, database } = await fixture(t);
  const batches: Statement[][] = [];
  const observed = observingBatch(database, batches);
  const proxy = proxyFor(dataDir, observed);
  await proxy.load();
  const initialMarker = await marker(database) as { importedAt: number; source: string; count: number };
  assert.equal(initialMarker.source, "index.json");
  assert.equal(initialMarker.count, 0);
  const url = "https://cdn.example/touched.png";
  proxy.proxied(url);
  await proxy.flush();
  batches.length = 0;

  proxy.proxied(url);
  await proxy.flush();

  assert.equal(batches.length, 1);
  assert.equal(batches[0]!.length, 1);
  assert.match(batches[0]![0]!.sql, /^INSERT INTO image_sources/);
  assert.deepEqual(batches[0]![0]!.params?.slice(0, 2), [imageId(url), url]);
});

test("a corrupt index is preserved while the database image registry keeps working", async (t) => {
  const { dataDir, imageDir, database, reopen } = await fixture(t);
  const image = path.join(imageDir, "orphan.png");
  await writeFile(image, Buffer.from([1, 2, 3]));
  await writeFile(path.join(imageDir, "index.json"), "{not json");

  const first = proxyFor(dataDir, database);
  await first.load();

  const recorded = await marker(database) as { importedAt: number; source: string; count: number };
  assert.equal(recorded.source, "unreadable");
  assert.equal(recorded.count, 0);
  assert.ok(Number.isInteger(recorded.importedAt));
  await assert.rejects(stat(path.join(imageDir, "index.json")), { code: "ENOENT" });
  await assert.rejects(stat(image), { code: "ENOENT" }, "an unregistered orphan is removed");
  const backups = await readdir(path.join(dataDir, "migration-backup"));
  assert.equal(backups.length, 1);
  assert.match(backups[0]!, /^images-index-\d+\.json$/);
  assert.equal(await readFile(path.join(dataDir, "migration-backup", backups[0]!), "utf8"), "{not json");
  await flushLog();
  const log = await readLog({ level: "ERROR" });
  assert.equal(log.match(/image cache index could not be imported/g)?.length, 1);

  const url = "https://cdn.example/after-corrupt-index.png";
  const id = imageId(url);
  first.proxied(url);
  await first.flush();

  const restarted = proxyFor(dataDir, await reopen());
  await restarted.load();
  assert.equal(restarted.source(id), url);
  assert.equal(restarted.original(`/api/image/${id}`), url);
});

test("a leftover index is moved and ignored when the marker is present", async (t) => {
  const { dataDir, imageDir, database } = await fixture(t);
  const keptUrl = "https://cdn.example/database.png";
  const keptId = imageId(keptUrl);
  await database.batch([
    {
      sql: "INSERT INTO image_sources (id, url, width, ext, bytes, at) VALUES (?, ?, ?, ?, ?, ?)",
      params: [keptId, keptUrl, null, null, null, 100],
    },
    {
      sql: "INSERT INTO meta (key, value) VALUES (?, ?)",
      params: ["domain.images", JSON.stringify({ importedAt: 90, source: "index.json", count: 1 })],
    },
  ]);
  const decoyId = imageId("https://cdn.example/decoy.png");
  await writeFile(path.join(imageDir, "index.json"), JSON.stringify({
    [decoyId]: { url: "https://cdn.example/decoy.png", at: 200 },
  }));

  const proxy = proxyFor(dataDir, database);
  await proxy.load();

  assert.equal(proxy.source(keptId), keptUrl);
  assert.equal(proxy.source(decoyId), undefined);
  await assert.rejects(stat(path.join(imageDir, "index.json")), { code: "ENOENT" });
  assert.equal((await readdir(path.join(dataDir, "migration-backup"))).length, 1);
});

test("a failed batch stays dirty for the next flush", async (t) => {
  const { dataDir, database } = await fixture(t);
  let failing = false;
  const wrapped = new Proxy(database, {
    get(target, property) {
      if (property === "batch") {
        return async (statements: Statement[]) => {
          if (failing) throw new Error("batch failed");
          return await target.batch(statements);
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const proxy = proxyFor(dataDir, wrapped);
  await proxy.load();
  const url = "https://cdn.example/retry.png";
  const id = imageId(url);
  proxy.proxied(url);

  failing = true;
  await proxy.flush();
  assert.equal(await database.get("SELECT id FROM image_sources WHERE id = ?", [id]), undefined);

  failing = false;
  await proxy.flush();
  assert.deepEqual(await database.get("SELECT id, url FROM image_sources WHERE id = ?", [id]), { id, url });
});
