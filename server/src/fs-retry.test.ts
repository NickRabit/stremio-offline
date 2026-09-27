import assert from "node:assert/strict";
import { test } from "node:test";
import { renameWithRetry, type RenameRetryOptions } from "./fs-retry.js";

const failure = (code: string) => Object.assign(new Error(`${code}: rename refused`), { code });

type RenameImpl = NonNullable<RenameRetryOptions["renameImpl"]>;

/** A rename that fails the given codes in order and then succeeds, recording its calls. */
const sequence = (codes: string[]): { calls: Array<[string, string]>; renameImpl: RenameImpl } => {
  const calls: Array<[string, string]> = [];
  const renameImpl: RenameImpl = async (from, to) => {
    calls.push([String(from), String(to)]);
    const code = codes[calls.length - 1];
    if (code) throw failure(code);
  };
  return { calls, renameImpl };
};

test("a refusal on another platform is the answer at once", async () => {
  const { calls, renameImpl } = sequence(["EPERM"]);
  await assert.rejects(renameWithRetry("/a", "/b", { platform: "linux", renameImpl }), { code: "EPERM" });
  assert.deepEqual(calls, [["/a", "/b"]]);
});

test("a code Windows does not lock on is not retried, on win32 either", async () => {
  const { calls, renameImpl } = sequence(["ENOENT"]);
  await assert.rejects(renameWithRetry("/a", "/b", { platform: "win32", renameImpl }), { code: "ENOENT" });
  assert.deepEqual(calls, [["/a", "/b"]]);
});

test("win32 waits out every locked code and lands the rename", async () => {
  for (const code of ["EPERM", "EBUSY", "EACCES"]) {
    const { calls, renameImpl } = sequence([code, code]);
    await renameWithRetry("/from", "/to", { platform: "win32", delayMs: 1, renameImpl });
    assert.equal(calls.length, 3, `${code} is retried until the rename goes through`);
    assert.deepEqual(calls[0], ["/from", "/to"], "the implementation gets the paths it was handed");
  }
});

test("the wait between attempts grows", async () => {
  const { calls, renameImpl } = sequence(["EPERM", "EPERM", "EPERM"]);
  const started = Date.now();
  await renameWithRetry("/a", "/b", { platform: "win32", attempts: 4, delayMs: 20, renameImpl });
  assert.equal(calls.length, 4);
  assert.ok(Date.now() - started >= 20 + 40 + 80, "the waits double: 20, 40, 80");
});

test("the last attempt throws rather than looping for ever", async () => {
  const { calls, renameImpl } = sequence(["EBUSY", "EBUSY", "EBUSY", "EBUSY", "EBUSY"]);
  await assert.rejects(renameWithRetry("/a", "/b", { platform: "win32", delayMs: 1, renameImpl }), { code: "EBUSY" });
  assert.equal(calls.length, 5, "five attempts by default");
});

test("the default schedule is the one the caller of the helper relies on", async () => {
  const { renameImpl } = sequence(Array.from({ length: 5 }, () => "EPERM"));
  const started = Date.now();
  await assert.rejects(renameWithRetry("/a", "/b", { platform: "win32", renameImpl }), { code: "EPERM" });
  assert.ok(Date.now() - started >= 750, "50 + 100 + 200 + 400 ms");
});
