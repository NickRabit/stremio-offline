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
      await writeShellPrefs(dir, { locale });
      assert.deepEqual(await readShellPrefs(dir), { locale });
    }
    assert.deepEqual(await readdir(dir), [SHELL_PREFS_FILE]);
  });
});

test("a missing file means the system decides", async () => {
  await withDir(async (dir) => {
    assert.deepEqual(await readShellPrefs(dir), { locale: null });
  });
});

test("a malformed or unexpected file means the system decides", async () => {
  await withDir(async (dir) => {
    const rejected = ["not json", "null", "[]", JSON.stringify({ locale: "de" }), JSON.stringify({ locale: 1 }), JSON.stringify({})];
    for (const text of rejected) {
      await writeFile(fileOf(dir), text, "utf8");
      assert.deepEqual(await readShellPrefs(dir), { locale: null }, text);
    }
  });
});

test("the file holds only the locale", async () => {
  await withDir(async (dir) => {
    await writeShellPrefs(dir, { locale: "cs" });
    assert.deepEqual(JSON.parse(await readFile(fileOf(dir), "utf8")), { locale: "cs" });
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
    assert.deepEqual(readShellPrefsSync(dir), { locale: null });
    const lenient = ["not json", "null", "[]", JSON.stringify({ locale: "de" }), JSON.stringify({ locale: 1 }), JSON.stringify({})];
    for (const text of lenient) {
      await writeFile(fileOf(dir), text, "utf8");
      assert.deepEqual(readShellPrefsSync(dir), await readShellPrefs(dir), text);
      assert.deepEqual(readShellPrefsSync(dir), { locale: null }, text);
    }
    for (const locale of ["cs", "en", null] as const) {
      await writeShellPrefs(dir, { locale });
      assert.deepEqual(readShellPrefsSync(dir), { locale });
      assert.deepEqual(readShellPrefsSync(dir), await readShellPrefs(dir));
    }
  });
});
