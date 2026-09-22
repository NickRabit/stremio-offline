import assert from "node:assert/strict";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { readSavedOrigin, writeSavedOrigin } from "./connection-file.js";

const withDir = async (body: (dir: string) => Promise<void>) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "stremio-desktop-"));
  try {
    await body(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
};

test("an origin that was written is read back", async () => {
  await withDir(async (dir) => {
    await writeSavedOrigin(dir, "http://192.168.1.20:8090");
    assert.equal(await readSavedOrigin(dir), "http://192.168.1.20:8090");
    assert.deepEqual(await readdir(dir), ["connection.json"]);
  });
});

test("a missing file has no origin", async () => {
  await withDir(async (dir) => {
    assert.equal(await readSavedOrigin(dir), null);
  });
});

test("a file that does not hold a usable origin is ignored", async () => {
  await withDir(async (dir) => {
    const file = path.join(dir, "connection.json");
    await writeFile(file, "not json", "utf8");
    assert.equal(await readSavedOrigin(dir), null);
    await writeFile(file, JSON.stringify({ origin: "http://8.8.8.8", token: "secret" }), "utf8");
    assert.equal(await readSavedOrigin(dir), null);
    await writeFile(file, JSON.stringify({ origin: "http://127.0.0.1:8090", token: "secret" }), "utf8");
    assert.equal(await readSavedOrigin(dir), "http://127.0.0.1:8090");
  });
});
