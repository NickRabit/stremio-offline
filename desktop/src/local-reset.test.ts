import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { forgetLocalState, removeIfPresent } from "./local-reset.js";

test("every step runs even after one fails, and the failures come back", async () => {
  const ran: string[] = [];
  const failures = await forgetLocalState([
    async () => { ran.push("session"); throw new Error("storage is locked"); },
    async () => { ran.push("settings"); },
    async () => { ran.push("profiles"); throw new Error("profiles.json is read-only"); },
  ]);
  assert.deepEqual(ran, ["session", "settings", "profiles"]);
  assert.deepEqual(failures, ["storage is locked", "profiles.json is read-only"]);
});

test("a clean reset reports nothing left behind", async () => {
  assert.deepEqual(await forgetLocalState([async () => undefined, async () => undefined]), []);
});

test("a file that is already gone is removed, one that will not go is a failure", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "local-reset-"));
  try {
    await writeFile(path.join(dir, "settings.json"), "{}");
    await removeIfPresent(path.join(dir, "settings.json"));
    await removeIfPresent(path.join(dir, "missing.json"));
    assert.deepEqual(await readdir(dir), []);
    // A directory under the name makes unlink fail with something other than ENOENT.
    await mkdir(path.join(dir, "busy.json"));
    const failures = await forgetLocalState([() => removeIfPresent(path.join(dir, "busy.json"))]);
    assert.equal(failures.length, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
