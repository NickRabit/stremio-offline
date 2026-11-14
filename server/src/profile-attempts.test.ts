import assert from "node:assert/strict";
import { test } from "node:test";
import { ProfileAttempts } from "./profile-attempts.js";

test("profile attempts are free five times, then wait with exponential backoff up to fifteen minutes", () => {
  let now = 1_000;
  const attempts = new ProfileAttempts(() => now);

  for (let count = 1; count <= 5; count += 1) {
    attempts.fail("usr_00000001");
    assert.equal(attempts.retryAfterMs("usr_00000001"), 0, `failure ${count}`);
  }

  attempts.fail("usr_00000001");
  assert.equal(attempts.retryAfterMs("usr_00000001"), 30_000);

  now += 30_000;
  assert.equal(attempts.retryAfterMs("usr_00000001"), 0);
  attempts.fail("usr_00000001");
  assert.equal(attempts.retryAfterMs("usr_00000001"), 60_000);

  for (let count = 8; count <= 15; count += 1) {
    now += attempts.retryAfterMs("usr_00000001");
    attempts.fail("usr_00000001");
  }
  assert.equal(attempts.retryAfterMs("usr_00000001"), 15 * 60_000);
});

test("the PIN locks exactly at ten failures and a success clears every part of the record", () => {
  let now = 1_000;
  const attempts = new ProfileAttempts(() => now);

  for (let count = 1; count <= 9; count += 1) attempts.fail("usr_00000001");
  assert.equal(attempts.pinLocked("usr_00000001"), false);
  attempts.fail("usr_00000001");
  assert.equal(attempts.pinLocked("usr_00000001"), true);
  assert.ok(attempts.retryAfterMs("usr_00000001") > 0);

  attempts.succeed("usr_00000001");
  assert.equal(attempts.pinLocked("usr_00000001"), false);
  assert.equal(attempts.retryAfterMs("usr_00000001"), 0);

  attempts.fail("usr_00000001");
  assert.equal(attempts.retryAfterMs("usr_00000001"), 0, "a cleared record starts its free attempts again");
});

test("profile attempts are counted separately for every target account", () => {
  const attempts = new ProfileAttempts(() => 1_000);
  for (let count = 0; count < 6; count += 1) attempts.fail("usr_00000001");

  assert.ok(attempts.retryAfterMs("usr_00000001") > 0);
  assert.equal(attempts.retryAfterMs("usr_00000002"), 0);
  assert.equal(attempts.pinLocked("usr_00000002"), false);
});
