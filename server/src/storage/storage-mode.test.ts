import assert from "node:assert/strict";
import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { chooseStorageMode } from "./storage-mode.js";
import { StorageError } from "./app-database.js";

async function fixture(t: TestContext) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "storage-mode-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  return dataDir;
}

test("storage mode uses an opened database", async (t) => {
  const dataDir = await fixture(t);
  const database = { state: "open" };

  assert.equal(await chooseStorageMode(dataDir, async () => database), database);
});

test("storage mode falls back to JSON when no database file exists and opening fails", async (t) => {
  const dataDir = await fixture(t);

  assert.equal(await chooseStorageMode(dataDir, async () => {
    throw new StorageError("broken", "SQLite is unavailable.");
  }), undefined);
});

test("storage mode refuses JSON after an existing database fails to open", async (t) => {
  const dataDir = await fixture(t);
  await writeFile(path.join(dataDir, "application.sqlite"), "existing database");
  const failure = new StorageError("broken", "The database worker exited.");

  await assert.rejects(
    chooseStorageMode(dataDir, async () => { throw failure; }),
    (error) => error === failure,
  );
});

test("a first open that created the file and then failed leaves no file behind", async (t) => {
  const dataDir = await fixture(t);
  const file = path.join(dataDir, "application.sqlite");

  assert.equal(await chooseStorageMode(dataDir, async () => {
    await writeFile(file, "");
    await writeFile(`${file}-wal`, "");
    throw new StorageError("broken", "The SQLite module is missing.");
  }), undefined);

  await assert.rejects(access(file));
  await assert.rejects(access(`${file}-wal`));
  // The next start is a first run again, not a refusal.
  assert.equal(await chooseStorageMode(dataDir, async () => {
    throw new StorageError("broken", "The SQLite module is missing.");
  }), undefined);
});
