import assert from "node:assert/strict";
import { test } from "node:test";
import type { Request, Response } from "express";
import { RestrictedError, restrictedMiddleware } from "./restricted.js";
import { ForbiddenError, USER_ALLOWED, isUserAllowed, roleMiddleware } from "./roles.js";
import type { Role } from "./users.js";

/** One concrete path per rule of USER_ALLOWED. The table is pinned in both directions, so
 *  a rule that matches no real path fails here instead of quietly widening the gate. */
const ALLOWED: Array<[string, string]> = [
  ["GET", "/auth/me"],
  ["POST", "/auth/login"],
  ["POST", "/auth/logout"],
  ["PATCH", "/auth/password"],
  ["GET", "/watchlist"],
  ["POST", "/watchlist"],
  ["GET", "/progress"],
  ["GET", "/progress/movie:tt1254207"],
  ["POST", "/progress"],
  ["DELETE", "/progress"],
  ["DELETE", "/progress/movie:tt1254207"],
  ["GET", "/library/favorites"],
  ["GET", "/library/resume"],
  ["POST", "/library/favorite"],
  ["GET", "/library"],
  ["GET", "/library/browse"],
  ["GET", "/library/thumb"],
  ["GET", "/library/next/movie:tt1254207"],
  ["GET", "/library/previous/movie:tt1254207"],
  ["POST", "/library/source"],
  ["GET", "/libraries"],
  ["GET", "/catalogs"],
  ["GET", "/catalog"],
  ["GET", "/search"],
  ["GET", "/searchable"],
  ["GET", "/meta/movie/tt1254207"],
  ["GET", "/links/movie/tt1254207"],
  ["GET", "/trailer/movie/tt1254207"],
  ["GET", "/library/links"],
  ["GET", "/library/trailer"],
  ["GET", "/image/poster"],
  ["GET", "/stream-sources/movie/tt1254207"],
  ["GET", "/streams/movie/tt1254207"],
  ["GET", "/subtitles/movie/tt1254207"],
  ["GET", "/subtitle/sub-1"],
  ["GET", "/addons"],
  ["GET", "/languages"],
  ["GET", "/settings"],
  ["POST", "/inspect"],
  ["POST", "/playback"],
  ["POST", "/playback/abc/ping"],
  ["POST", "/playback/abc/seek"],
  ["POST", "/playback/abc/escalate"],
  ["POST", "/playback/abc/track"],
  ["GET", "/playback/abc/preview"],
  ["GET", "/playback/abc/sidecar.vtt"],
  ["GET", "/playback/abc/1/master.m3u8"],
  ["DELETE", "/playback/abc"],
  ["GET", "/media/abc"],
  ["GET", "/media/abc/u/signature"],
  ["POST", "/device-download"],
  ["GET", "/device-download/abc"],
  ["POST", "/client-log"],
  ["GET", "/downloads"],
  ["POST", "/downloads"],
  ["POST", "/downloads/bulk"],
  ["POST", "/downloads/job-1/pause"],
  ["POST", "/downloads/job-1/resume"],
  ["POST", "/downloads/job-1/retry"],
  ["DELETE", "/downloads/job-1"],
  ["PATCH", "/settings"],
];

/** What an ordinary user must not reach: the instance's configuration, the host's
 *  directories, the household's numbers and the rows that belong to everybody. */
const REFUSED: Array<[string, string]> = [
  ["GET", "/addons/example/export"],
  ["POST", "/addons"],
  ["POST", "/addons/example/move"],
  ["POST", "/libraries"],
  ["GET", "/libraries/browse"],
  ["GET", "/libraries/grants"],
  ["DELETE", "/library/item"],
  ["POST", "/library/rename"],
  ["POST", "/library/match"],
  ["POST", "/library/scan"],
  ["GET", "/logs"],
  ["GET", "/diagnostics"],
  ["GET", "/stats/streams"],
  ["GET", "/settings/export"],
  ["POST", "/downloads/job-1/move"],
  ["DELETE", "/downloads"],
];

const invoke = (method: string, path: string, opts?: { role?: Role; isOpen?: boolean; isInternal?: boolean }) => {
  let passed: unknown = "not-called";
  roleMiddleware({
    isOpen: () => Boolean(opts?.isOpen),
    isInternal: () => Boolean(opts?.isInternal),
    roleOf: () => opts?.role,
  })({ method, path } as Request, {} as Response, ((error?: unknown) => { passed = error; }) as () => void);
  return passed;
};

test("ForbiddenError is a 403 with err.notAllowed", () => {
  const error = new ForbiddenError();
  assert.equal(error.status, 403);
  assert.equal(error.messageKey, "err.notAllowed");
  assert.equal(error.message, "This account may not do that.");
});

test("USER_ALLOWED matches every allowed path and holds no orphan rule", () => {
  for (const [method, path] of ALLOWED) assert.equal(isUserAllowed(method, path), true, `${method} ${path}`);
  for (const rule of USER_ALLOWED) {
    assert.ok(
      ALLOWED.some(([method, path]) => rule.method === method && rule.pattern.test(path)),
      `orphan USER_ALLOWED ${rule.method} ${rule.pattern}`,
    );
  }
});

test("an administrator passes every allowed path and the ones outside the table", () => {
  for (const [method, path] of [...ALLOWED, ...REFUSED, ["POST", "/something-new"] as [string, string]]) {
    assert.equal(invoke(method, path, { role: "admin" }), undefined, `${method} ${path}`);
  }
});

test("an ordinary user reaches the allowed paths and is refused the rest", () => {
  for (const [method, path] of ALLOWED) assert.equal(invoke(method, path, { role: "user" }), undefined, `${method} ${path}`);
  for (const [method, path] of REFUSED) {
    const error = invoke(method, path, { role: "user" });
    assert.ok(error instanceof ForbiddenError, `${method} ${path}`);
    assert.equal(error.status, 403, `${method} ${path}`);
    assert.equal(error.messageKey, "err.notAllowed", `${method} ${path}`);
  }
});

/** The property the allow-list exists for: a route nobody has classified yet closes. */
test("a path nobody has classified is refused for an ordinary user", () => {
  const error = invoke("POST", "/something-new", { role: "user" });
  assert.ok(error instanceof ForbiddenError);
  assert.equal(error.status, 403);
  assert.equal(error.messageKey, "err.notAllowed");
});

test("an open path, an internal read and a request with no role pass through", () => {
  assert.equal(invoke("GET", "/status", { isOpen: true }), undefined);
  assert.equal(invoke("POST", "/auth/login", { isOpen: true }), undefined);
  assert.equal(invoke("GET", "/media/abc", { isInternal: true }), undefined);
  assert.equal(invoke("POST", "/addons"), undefined, "the auth gate ahead has already answered");
});

test("the role gate and the restricted gate are independent", (t) => {
  const previous = process.env.RESTRICTED_MODE;
  t.after(() => {
    if (previous === undefined) delete process.env.RESTRICTED_MODE;
    else process.env.RESTRICTED_MODE = previous;
  });

  /** Both gates in the order index.ts mounts them. `POST /addons` is outside USER_ALLOWED
   *  and is also not an allowed mutation, so only an administrator ever reaches the second. */
  const run = (role: Role | undefined) => {
    let result: unknown = "not-called";
    const request = { method: "POST", path: "/addons" } as Request;
    roleMiddleware({ isOpen: () => false, isInternal: () => false, roleOf: () => role })(request, {} as Response, (error?: unknown) => {
      if (error !== undefined) { result = error; return; }
      restrictedMiddleware({ isOpen: () => false, isInternal: () => false })(request, {} as Response, (denied?: unknown) => { result = denied; });
    });
    return result;
  };

  delete process.env.RESTRICTED_MODE;
  assert.equal(run("admin"), undefined, "an administrator is not stopped by the role gate");
  process.env.RESTRICTED_MODE = "1";
  assert.ok(run("admin") instanceof RestrictedError, "and is still stopped by the restricted gate");
  assert.ok(run("user") instanceof ForbiddenError, "an ordinary user is stopped by the role gate");
});
