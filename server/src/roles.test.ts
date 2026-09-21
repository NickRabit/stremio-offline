import assert from "node:assert/strict";
import { test } from "node:test";
import type { Request, Response } from "express";
import { RestrictedError, restrictedMiddleware } from "./restricted.js";
import { AppError } from "./errors.js";
import { assertStillAdmin, ForbiddenError, MUST_CHANGE_ALLOWED, USER_ALLOWED, isMustChangePathAllowed, isUserAllowed, passwordChangeMiddleware, roleMiddleware } from "./roles.js";
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
  ["GET", "/views"],
  ["PATCH", "/views"],
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
  ["PUT", "/addons/order"],
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

const invokePasswordChange = (method: string, path: string, opts?: { mustChange?: boolean; isOpen?: boolean; isInternal?: boolean }) => {
  let passed: unknown = "not-called";
  passwordChangeMiddleware({
    isOpen: () => Boolean(opts?.isOpen),
    isInternal: () => Boolean(opts?.isInternal),
    mustChange: () => opts?.mustChange,
  })({ method, path } as Request, {} as Response, ((error?: unknown) => { passed = error; }) as () => void);
  return passed;
};

const MUST_CHANGE_PATHS: Array<[string, string]> = [["GET", "/auth/me"], ["PATCH", "/auth/password"], ["POST", "/auth/logout"]];

test("an account that must change its password reaches the account endpoints and nothing else", () => {
  for (const [method, path] of MUST_CHANGE_PATHS) {
    assert.equal(isMustChangePathAllowed(method, path), true, `${method} ${path}`);
    assert.equal(invokePasswordChange(method, path, { mustChange: true }), undefined, `${method} ${path}`);
  }
  // Paths the role gate lets an ordinary user reach are refused here: the two gates answer
  // different questions, and a password somebody else chose closes browsing and downloading.
  const otherPaths = ALLOWED.filter(([method, path]) => !MUST_CHANGE_PATHS.some(([m, p]) => m === method && p === path));
  for (const [method, path] of otherPaths) assert.equal(isMustChangePathAllowed(method, path), false, `${method} ${path}`);
  assert.equal(MUST_CHANGE_ALLOWED.length, MUST_CHANGE_PATHS.length);
  const error = invokePasswordChange("GET", "/library", { mustChange: true });
  assert.ok(error instanceof AppError, "a third endpoint is refused");
  assert.equal(error.status, 403);
  assert.equal(error.messageKey, "err.mustChangePassword");
  assert.equal(error.message, "Change your password before continuing.");
});

test("the password-change gate passes an account that owes nothing, an open path and an internal read", () => {
  assert.equal(invokePasswordChange("GET", "/library"), undefined, "nothing is owed");
  assert.equal(invokePasswordChange("GET", "/library", { mustChange: false }), undefined);
  assert.equal(invokePasswordChange("GET", "/library", { mustChange: true, isOpen: true }), undefined);
  assert.equal(invokePasswordChange("GET", "/media/abc", { mustChange: true, isInternal: true }), undefined);
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

test("the write-time role check refuses every way an actor can have gone stale", () => {
  const ada = { id: "usr_00000001", role: "admin" as Role, secret: "ada-secret" };
  const users = [ada, { id: "usr_00000002", role: "user" as Role, secret: "bob-secret" }];

  assert.equal(assertStillAdmin(users, ada), undefined, "an administrator who is still one passes");

  // Every one of these is a state the request could have entered while it was awaiting, and
  // each has to answer 403 rather than throw its way to a 500.
  assert.throws(() => assertStillAdmin(users, undefined), ForbiddenError,
    "a request that reaches the write with nobody to speak for it");
  assert.throws(() => assertStillAdmin(users, { id: "usr_00000009", secret: "gone" }), ForbiddenError,
    "an account deleted while the request waited");
  assert.throws(() => assertStillAdmin(users, { id: ada.id, secret: "an-older-secret" }), ForbiddenError,
    "a password change or a sign-out everywhere rotated the secret");
  assert.throws(() => assertStillAdmin([{ ...ada, role: "user" }], ada), ForbiddenError, "a demotion");
  assert.throws(() => assertStillAdmin([{ ...ada, disabled: true }], ada), ForbiddenError, "the account switched off");
});
