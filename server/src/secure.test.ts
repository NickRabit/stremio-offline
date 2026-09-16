import assert from "node:assert/strict";
import test from "node:test";
import { configureSecureMode, contentSecurityPolicy, secureMode } from "./secure.js";

test("an instance nobody configured is already secure", () => {
  assert.equal(secureMode(), true);
});

test("the policy lets nothing but this instance load anything", () => {
  configureSecureMode(() => true);
  const policy = contentSecurityPolicy();
  assert.match(policy, /img-src 'self' data: blob:(;|$)/);
  assert.doesNotMatch(policy, /frame-src/);
  for (const directive of ["default-src 'self'", "connect-src 'self'", "script-src 'self'", "frame-ancestors 'none'"]) {
    assert.ok(policy.includes(directive), `${directive} missing from ${policy}`);
  }
});

test("turned off in settings, remote artwork is allowed again", () => {
  configureSecureMode(() => false);
  try {
    assert.match(contentSecurityPolicy(), /img-src 'self' data: blob: https: http:/);
    assert.match(contentSecurityPolicy(), /frame-src 'self' https:\/\/www\.youtube-nocookie\.com/);
  }
  finally { configureSecureMode(() => true); }
});
