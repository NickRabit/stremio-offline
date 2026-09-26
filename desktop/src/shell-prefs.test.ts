import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { SHELL_PREFS_FILE, effectiveLocale, readShellPrefs, readShellPrefsSync, writeShellPrefs } from "./shell-prefs.js";

const withDir = async (body: (dir: string) => Promise<void>) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "stremio-shell-prefs-"));
  try {
    await body(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
};

const fileOf = (dir: string) => path.join(dir, SHELL_PREFS_FILE);

test("a chosen language survives a round trip", async () => {
  await withDir(async (dir) => {
    for (const locale of ["cs", "en", null] as const) {
      await writeShellPrefs(dir, { locale, checkUpdates: true });
      assert.deepEqual(await readShellPrefs(dir), { locale, checkUpdates: true });
    }
    assert.deepEqual(await readdir(dir), [SHELL_PREFS_FILE]);
  });
});

test("a missing file means the system decides", async () => {
  await withDir(async (dir) => {
    assert.deepEqual(await readShellPrefs(dir), { locale: null, checkUpdates: true });
  });
});

test("a malformed or unexpected file means the system decides", async () => {
  await withDir(async (dir) => {
    const rejected = ["not json", "null", "[]", JSON.stringify({ locale: "de" }), JSON.stringify({ locale: 1 }), JSON.stringify({})];
    for (const text of rejected) {
      await writeFile(fileOf(dir), text, "utf8");
      assert.deepEqual(await readShellPrefs(dir), { locale: null, checkUpdates: true }, text);
    }
  });
});

test("the file holds the locale and the update check", async () => {
  await withDir(async (dir) => {
    await writeShellPrefs(dir, { locale: "cs", checkUpdates: false });
    assert.deepEqual(JSON.parse(await readFile(fileOf(dir), "utf8")), { locale: "cs", checkUpdates: false });
  });
});

test("turning the update check off survives a round trip", async () => {
  await withDir(async (dir) => {
    for (const checkUpdates of [true, false]) {
      await writeShellPrefs(dir, { locale: "en", checkUpdates });
      assert.deepEqual(await readShellPrefs(dir), { locale: "en", checkUpdates });
      assert.deepEqual(readShellPrefsSync(dir), { locale: "en", checkUpdates });
    }
  });
});

test("a file written before the update check existed keeps it on", async () => {
  await withDir(async (dir) => {
    await writeFile(fileOf(dir), JSON.stringify({ locale: "cs" }), "utf8");
    assert.deepEqual(await readShellPrefs(dir), { locale: "cs", checkUpdates: true });
    await writeFile(fileOf(dir), JSON.stringify({ locale: "cs", checkUpdates: "no" }), "utf8");
    assert.deepEqual(await readShellPrefs(dir), { locale: "cs", checkUpdates: true });
  });
});

test("the choice wins, else Czech, else English", () => {
  assert.equal(effectiveLocale("en", "cs-CZ"), "en");
  assert.equal(effectiveLocale("cs", "en-US"), "cs");
  assert.equal(effectiveLocale(null, "cs-CZ"), "cs");
  assert.equal(effectiveLocale(null, "CS"), "cs");
  assert.equal(effectiveLocale(null, "en-US"), "en");
  assert.equal(effectiveLocale(null, ""), "en");
});

test("the synchronous read answers exactly like the asynchronous one", async () => {
  await withDir(async (dir) => {
    assert.deepEqual(readShellPrefsSync(dir), { locale: null, checkUpdates: true });
    const lenient = ["not json", "null", "[]", JSON.stringify({ locale: "de" }), JSON.stringify({ locale: 1 }), JSON.stringify({})];
    for (const text of lenient) {
      await writeFile(fileOf(dir), text, "utf8");
      assert.deepEqual(readShellPrefsSync(dir), await readShellPrefs(dir), text);
      assert.deepEqual(readShellPrefsSync(dir), { locale: null, checkUpdates: true }, text);
    }
    for (const locale of ["cs", "en", null] as const) {
      await writeShellPrefs(dir, { locale, checkUpdates: true });
      assert.deepEqual(readShellPrefsSync(dir), { locale, checkUpdates: true });
      assert.deepEqual(readShellPrefsSync(dir), await readShellPrefs(dir));
    }
  });
});
