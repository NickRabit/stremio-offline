import assert from "node:assert/strict";
import test from "node:test";
import { renameWithRetry } from "./fs-retry.js";

const locked = (code: string) => Object.assign(new Error(`rename ${code}`), { code });

/** A rename that fails with `codes` in order and then succeeds; the calls are kept. */
const failing = (codes: string[]) => {
  const calls: Array<{ from: string; to: string }> = [];
  const renameImpl = async (from: string, to: string): Promise<void> => {
    calls.push({ from, to });
    const code = codes.shift();
    if (code !== undefined) throw locked(code);
  };
  return { calls, renameImpl };
};

test("a rename on another platform is not retried, whatever the error says", async () => {
  for (const platform of ["darwin", "linux"] as const) {
    const { calls, renameImpl } = failing(["EPERM", "EBUSY", "EACCES"]);
    await assert.rejects(renameWithRetry("a", "b", { platform, delayMs: 0, renameImpl }), /rename EPERM/);
    assert.equal(calls.length, 1, platform);
  }
});

test("a Windows lock is waited out and the rename is tried again", async () => {
  for (const code of ["EPERM", "EBUSY", "EACCES"]) {
    const { calls, renameImpl } = failing([code]);
    await renameWithRetry("from", "to", { platform: "win32", delayMs: 0, renameImpl });
    assert.deepEqual(calls, [{ from: "from", to: "to" }, { from: "from", to: "to" }], code);
  }
});

test("another Windows error is not a lock and is thrown at once", async () => {
  for (const code of ["ENOENT", "EXDEV", "EISDIR"]) {
    const { calls, renameImpl } = failing([code]);
    await assert.rejects(renameWithRetry("a", "b", { platform: "win32", delayMs: 0, renameImpl }), new RegExp(`rename ${code}`));
    assert.equal(calls.length, 1, code);
  }
  const { calls, renameImpl } = failing(["EPERM"]);
  await assert.rejects(renameWithRetry("a", "b", { platform: "win32", delayMs: 0, attempts: 1, renameImpl }), /rename EPERM/);
  assert.equal(calls.length, 1, "the last attempt does not wait again");
});

test("a folder that stays locked is given up on after the last attempt", async () => {
  const { calls, renameImpl } = failing(["EPERM", "EPERM", "EPERM", "EPERM", "EPERM", "EPERM"]);
  await assert.rejects(renameWithRetry("a", "b", { platform: "win32", delayMs: 0, renameImpl }), /rename EPERM/);
  assert.equal(calls.length, 5, "five attempts by default");

  const counted = failing(["EBUSY", "EBUSY"]);
  await renameWithRetry("a", "b", { platform: "win32", delayMs: 0, attempts: 3, renameImpl: counted.renameImpl });
  assert.equal(counted.calls.length, 3);
});

test("the wait grows with every attempt", async () => {
  const { calls, renameImpl } = failing(["EPERM", "EPERM"]);
  const started = Date.now();
  await renameWithRetry("a", "b", { platform: "win32", delayMs: 20, renameImpl });
  assert.equal(calls.length, 3);
  assert.ok(Date.now() - started >= 50, "20 ms after the first failure and 40 ms after the second");
});
