import assert from "node:assert/strict";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { readRememberedPort, writeRememberedPort } from "./local-backend.js";
import {
  SETTINGS_FILE,
  defaultLocalSettings,
  parseLocalSettings,
  readLocalSettings,
  writeLocalSettings,
} from "./local-settings.js";

const withDir = async (body: (dir: string) => Promise<void>) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "stremio-desktop-settings-"));
  try {
    await body(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
};

const fileOf = (dir: string) => path.join(dir, SETTINGS_FILE);

test("a missing file is the default settings", async () => {
  await withDir(async (dir) => {
    assert.deepEqual(await readLocalSettings(dir), { allowPrivateAddons: false, publish: false, publishPort: 8091 });
  });
});

test("a malformed file is the default settings", async () => {
  await withDir(async (dir) => {
    await writeFile(fileOf(dir), "{ not json", "utf8");
    assert.deepEqual(await readLocalSettings(dir), defaultLocalSettings());
  });
});

test("a stored file that is not an object is the default settings", async () => {
  await withDir(async (dir) => {
    for (const body of ["null", "[]", "\"true\"", "7"]) {
      await writeFile(fileOf(dir), body, "utf8");
      assert.deepEqual(await readLocalSettings(dir), defaultLocalSettings(), body);
    }
  });
});

test("a non-boolean switch in the file falls back to the default", async () => {
  await withDir(async (dir) => {
    for (const value of ["\"true\"", "1", "null", "{}"]) {
      await writeFile(fileOf(dir), `{"allowPrivateAddons":${value}}`, "utf8");
      assert.deepEqual(await readLocalSettings(dir), defaultLocalSettings(), value);
    }
  });
});

test("each field is read leniently, a bad one taking its own default", async () => {
  await withDir(async (dir) => {
    await writeFile(fileOf(dir), JSON.stringify({ allowPrivateAddons: true, publish: "yes", publishPort: 80 }), "utf8");
    assert.deepEqual(await readLocalSettings(dir), { allowPrivateAddons: true, publish: false, publishPort: 8091 });
    await writeFile(fileOf(dir), JSON.stringify({ allowPrivateAddons: 1, publish: true, publishPort: 8095 }), "utf8");
    assert.deepEqual(await readLocalSettings(dir), { allowPrivateAddons: false, publish: true, publishPort: 8095 });
  });
});

test("a port outside 1024..65535 in the file falls back to the default", async () => {
  await withDir(async (dir) => {
    for (const value of [1023, 65536, 8091.5, "8091", null, -1]) {
      await writeFile(fileOf(dir), JSON.stringify({ publishPort: value }), "utf8");
      assert.deepEqual(await readLocalSettings(dir), defaultLocalSettings(), JSON.stringify(value));
    }
    await writeFile(fileOf(dir), JSON.stringify({ publishPort: 1024 }), "utf8");
    assert.equal((await readLocalSettings(dir)).publishPort, 1024);
    await writeFile(fileOf(dir), JSON.stringify({ publishPort: 65535 }), "utf8");
    assert.equal((await readLocalSettings(dir)).publishPort, 65535);
  });
});

test("unknown fields in the file are ignored", async () => {
  await withDir(async (dir) => {
    await writeFile(fileOf(dir), JSON.stringify({ allowPrivateAddons: true, port: 8090 }), "utf8");
    assert.deepEqual(await readLocalSettings(dir), { allowPrivateAddons: true, publish: false, publishPort: 8091 });
  });
});

test("settings that were written are read back", async () => {
  await withDir(async (dir) => {
    await writeLocalSettings(dir, { allowPrivateAddons: true, publish: true, publishPort: 8095 });
    assert.deepEqual(await readLocalSettings(dir), { allowPrivateAddons: true, publish: true, publishPort: 8095 });
    assert.deepEqual(await readdir(dir), [SETTINGS_FILE]);
    await writeLocalSettings(dir, { allowPrivateAddons: false, publish: false, publishPort: 8091 });
    assert.deepEqual(await readLocalSettings(dir), { allowPrivateAddons: false, publish: false, publishPort: 8091 });
    assert.deepEqual(await readdir(dir), [SETTINGS_FILE]);
  });
});

test("the switch is saved on its own, not over the remembered port", async () => {
  await withDir(async (dir) => {
    await writeRememberedPort(dir, 8090);
    await writeLocalSettings(dir, { allowPrivateAddons: true, publish: false, publishPort: 8091 });
    assert.equal(await readRememberedPort(dir), 8090);
    assert.deepEqual([...await readdir(dir)].sort(), ["local-backend.json", SETTINGS_FILE]);
  });
});

test("the IPC input has exactly three fields with the right types", () => {
  assert.deepEqual(parseLocalSettings({ allowPrivateAddons: true, publish: true, publishPort: 8091 }),
    { allowPrivateAddons: true, publish: true, publishPort: 8091 });
  assert.deepEqual(parseLocalSettings({ allowPrivateAddons: false, publish: false, publishPort: 8095 }),
    { allowPrivateAddons: false, publish: false, publishPort: 8095 });
  const rejected: unknown[] = [
    null,
    undefined,
    "true",
    true,
    0,
    [],
    [{ allowPrivateAddons: true, publish: false, publishPort: 8091 }],
    {},
    { allowPrivateAddons: true, publish: false },
    { allowPrivateAddons: true, publish: false, publishPort: 8091, extra: 1 },
    { allowPrivateAddons: "true" },
    { allowPrivateAddons: 1 },
    { allowPrivateAddons: null },
    { allowPrivateAddons: true, publish: false, publishPort: 1023 },
    { allowPrivateAddons: true, publish: false, publishPort: 65536 },
    { allowPrivateAddons: true, publish: false, publishPort: 8091.5 },
    { allowPrivateAddons: true, publish: false, publishPort: "8091" },
    { allowPrivateAddons: true, publish: 1, publishPort: 8091 },
    { allowPrivateAddons: true, publish: false, port: 8090 },
  ];
  for (const input of rejected) assert.equal(parseLocalSettings(input), null, JSON.stringify(input));
});
