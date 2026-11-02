import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
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
  ["POST", "/progress/forget"],
  ["DELETE", "/progress"],
  ["DELETE", "/progress/movie:tt1254207"],
  ["GET", "/library/favorites"],
  ["GET", "/favorites"],
  ["GET", "/resume"],
  ["GET", "/library/resume"],
  ["POST", "/library/favorite"],
  ["GET", "/views"],
  ["PATCH", "/views"],
  ["GET", "/search/state"],
  ["GET", "/search/preferences"],
  ["PATCH", "/search/preferences"],
  ["POST", "/search/history"],
  ["POST", "/search/history/forget"],
  ["DELETE", "/search/history"],
  ["POST", "/search/everywhere"],
  ["POST", "/search/everywhere/ss_abc/poll"],
  ["POST", "/search/everywhere/ss_abc/page"],
  ["POST", "/search/everywhere/ss_abc/sources/s0/retry"],
  ["GET", "/search/everywhere/ss_abc/members/member_1"],
  ["DELETE", "/search/everywhere/ss_abc"],
  ["POST", "/search/catalog"],
  ["POST", "/search/catalog/cs_abc/poll"],
  ["POST", "/search/catalog/cs_abc/page"],
  ["DELETE", "/search/catalog/cs_abc"],
  ["GET", "/follows"],
  ["POST", "/follows"],
  ["GET", "/follows/defaults"],
  ["PUT", "/follows/defaults"],
  ["GET", "/source-profiles"],
  ["GET", "/follows/calendar"],
  ["GET", "/follows/calendar-feed"],
  ["POST", "/follows/calendar-feed"],
  ["DELETE", "/follows/calendar-feed"],
  ["GET", "/follows/activity"],
  ["GET", "/follows/new-episodes"],
  ["GET", "/follows/by-meta/series/tt1254207"],
  ["PATCH", "/follows/f-1"],
  ["DELETE", "/follows/f-1"],
  ["POST", "/follows/f-1/check"],
  ["GET", "/follows/f-1/episodes"],
  ["GET", "/follows/f-1/preview"],
  ["POST", "/follows/f-1/episodes/1:2/skip"],
  ["POST", "/follows/f-1/episodes/1:2/retry"],
  ["GET", "/library"],
  ["GET", "/library/browse"],
  ["GET", "/library/folders"],
  ["GET", "/library/gallery"],
  ["GET", "/library/identity"],
  ["GET", "/library/mosaic"],
  ["GET", "/library/thumb"],
  ["GET", "/library/next/movie:tt1254207"],
  ["GET", "/library/previous/movie:tt1254207"],
  ["POST", "/library/source"],
  ["GET", "/libraries"],
  ["GET", "/remote-libraries"],
  ["GET", "/remote-libraries/rlib_00000000000000000000000000000001/browse"],
  ["GET", "/remote-libraries/rlib_00000000000000000000000000000001/preview"],
  ["GET", "/remote-libraries/rlib_00000000000000000000000000000001/items"],
  ["GET", "/remote-libraries/rlib_00000000000000000000000000000001/items/item-1"],
  ["GET", "/remote-libraries/rlib_00000000000000000000000000000001/items/item-1/episodes"],
  ["GET", "/remote-libraries/rlib_00000000000000000000000000000001/items/item-1/sources"],
  ["GET", "/remote-libraries/rlib_00000000000000000000000000000001/items/item-1/state"],
  ["GET", "/remote-libraries/rlib_00000000000000000000000000000001/items/item-1/artwork/Primary"],
  ["GET", "/remote-libraries/rlib_00000000000000000000000000000001/items/item-1/artwork/Backdrop"],
  ["GET", "/remote-libraries/rlib_00000000000000000000000000000001/items/item-1/artwork/Thumb"],
  ["GET", "/remote-libraries/rlib_00000000000000000000000000000001/mosaic"],
  ["GET", "/remote-libraries/rlib_00000000000000000000000000000001/streams/movie/tt1254207"],
  ["GET", "/remote-libraries/personal"],
  ["PATCH", "/remote-libraries/rlib_00000000000000000000000000000001/items/item-1/state"],
  ["POST", "/remote-libraries/rlib_00000000000000000000000000000001/items/item-1/playing"],
  ["GET", "/home"],
  ["GET", "/home/layout"],
  ["GET", "/catalogs"],
  ["GET", "/catalog"],
  ["GET", "/search"],
  ["GET", "/searchable"],
  ["GET", "/meta/movie/tt1254207"],
  ["GET", "/meta/movie/tt1254207/extras"],
  ["GET", "/meta/series/tt1254207/extras"],
  ["GET", "/links/movie/tt1254207"],
  ["GET", "/trailer/movie/tt1254207"],
  ["GET", "/intro-segments"],
  ["GET", "/library/links"],
  ["GET", "/library/trailer"],
  ["GET", "/library/title"],
  ["GET", "/image/poster"],
  ["GET", "/stream-sources/movie/tt1254207"],
  ["GET", "/streams/movie/tt1254207"],
  ["GET", "/local-streams/movie/tt1254207"],
  ["GET", "/local-streams/series/tt1254207%3A1%3A1"],
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
  ["DELETE", "/device-transfers/abc"],
  ["DELETE", "/device-transfers"],
  ["POST", "/client-log"],
  ["POST", "/client-log/bundle"],
  ["GET", "/downloads"],
  ["POST", "/downloads"],
  ["POST", "/downloads/bulk"],
  ["POST", "/downloads/bulk/prepare"],
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
  ["GET", "/media-servers"],
  ["GET", "/media-servers/export"],
  ["GET", "/media-servers/libraries"],
  ["GET", "/media-servers/mconn_00000000000000000000000000000001/libraries"],
  ["POST", "/media-servers"],
  ["POST", "/media-servers/import"],
  ["POST", "/media-servers/mconn_00000000000000000000000000000001/reauthenticate"],
  ["POST", "/media-servers/mconn_00000000000000000000000000000001/libraries"],
  ["PATCH", "/media-servers/mconn_00000000000000000000000000000001"],
  ["DELETE", "/media-servers/mconn_00000000000000000000000000000001"],
  ["PATCH", "/remote-libraries/rlib_00000000000000000000000000000001"],
  ["DELETE", "/remote-libraries/rlib_00000000000000000000000000000001"],
  ["POST", "/remote-libraries/rlib_00000000000000000000000000000001/browse"],
  ["PATCH", "/remote-libraries/rlib_00000000000000000000000000000001/browse"],
  ["POST", "/remote-libraries/rlib_00000000000000000000000000000001/preview"],
  ["GET", "/remote-libraries/rlib_00000000000000000000000000000001/items/item-1/artwork/Logo"],
  ["POST", "/remote-libraries/rlib_00000000000000000000000000000001/items/item-1/artwork/Thumb"],
  ["POST", "/remote-libraries/rlib_00000000000000000000000000000001/mosaic"],
  ["DELETE", "/library/item"],
  ["POST", "/library/rename"],
  ["POST", "/library/match"],
  ["GET", "/library/search"],
  ["GET", "/library/suggestions"],
  ["GET", "/library/scan"],
  ["POST", "/library/scan"],
  ["GET", "/library/ops"],
  ["POST", "/library/mosaic"],
  ["POST", "/library/gallery"],
  ["POST", "/meta/movie/tt1254207/extras"],
  ["GET", "/logs"],
  ["GET", "/diagnostics"],
  ["GET", "/client-logs"],
  ["GET", "/client-logs/abc"],
  ["DELETE", "/client-logs/abc"],
  ["GET", "/stats/streams"],
  ["GET", "/stats/activity"],
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

test("the search everywhere routes match exact parameter counts only", () => {
  assert.equal(isUserAllowed("GET", "/search/preferences"), true);
  assert.equal(isUserAllowed("PATCH", "/search/preferences"), true, "the existing preference write stays");
  assert.equal(isUserAllowed("GET", "/search/state"), true);
  assert.equal(isUserAllowed("POST", "/search/history"), true);
  assert.equal(isUserAllowed("GET", "/search/everywhere/x/y/z"), false);
  assert.equal(isUserAllowed("POST", "/search/everywhere/x/y/z"), false);
  assert.equal(isUserAllowed("POST", "/search/everywhere/x/poll/extra"), false);
  assert.equal(isUserAllowed("GET", "/search/everywhere/x/members/y/extra"), false);
  assert.equal(isUserAllowed("POST", "/search/catalog/x/poll/extra"), false);
  assert.equal(isUserAllowed("POST", "/search/catalog/x/page/extra"), false);
  assert.equal(isUserAllowed("DELETE", "/search/catalog/x/extra"), false);
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

/** Every route the server registers must be classified: reachable by an ordinary account
 *  through USER_ALLOWED, or named below as administrator-only. A new route that is neither
 *  fails here, so the decision is made in the pull request that adds it rather than by a
 *  non-admin account meeting a 403 in production. Paths are as registered, without `/api`. */
const ADMIN_ONLY = new Set([
  // Answered before the role gate (OPEN_PATHS), so the allowlist never sees them.
  "POST /auth/setup",
  "GET /status",
  // Addons, accounts, servers, logs and statistics.
  "POST /addons", "PATCH /addons/:key", "DELETE /addons/:key", "POST /addons/:key/move",
  "POST /addons/:key/refresh", "POST /addons/refresh", "GET /addons/:key/export",
  "GET /admin/source-profiles", "POST /admin/source-profiles", "PATCH /admin/source-profiles/:id",
  "DELETE /admin/source-profiles/:id", "POST /admin/source-profiles/:id/duplicate",
  "GET /users", "POST /users", "PATCH /users/:id", "DELETE /users/:id", "PATCH /users/:id/password",
  "GET /logs", "DELETE /logs", "GET /client-logs", "GET /client-logs/:id", "DELETE /client-logs/:id",
  "GET /diagnostics", "GET /stats", "GET /stats/activity", "GET /stats/streams",
  "GET /settings/export", "POST /settings/import",
  // Libraries and their curation.
  "POST /libraries", "PATCH /libraries/:id", "DELETE /libraries/:id", "POST /libraries/:id/reroot",
  "GET /libraries/browse", "POST /libraries/preview",
  "GET /libraries/grants", "POST /libraries/grants", "DELETE /libraries/grants",
  "GET /library/search", "GET /library/suggestions", "DELETE /library/suggestion",
  "POST /library/match", "POST /library/rename", "POST /library/move", "POST /library/folder",
  "DELETE /library/item", "GET /library/scan", "POST /library/scan", "POST /library/scan/stop",
  "GET /library/ops", "POST /library/ops", "DELETE /library/ops/:id",
  "DELETE /downloads", "POST /downloads/:id/move",
  // Media-server administration.
  "GET /media-servers", "POST /media-servers", "PATCH /media-servers/:id", "DELETE /media-servers/:id",
  "GET /media-servers/:id/libraries", "POST /media-servers/:id/libraries",
  "POST /media-servers/:id/reauthenticate", "GET /media-servers/export", "POST /media-servers/import",
  "GET /media-servers/libraries", "PATCH /remote-libraries/:id", "DELETE /remote-libraries/:id",
]);

/** A concrete value for a route parameter whose rule accepts only some values. */
const SAMPLE_PARAMS: Record<string, string> = { imageType: "Primary" };

const registeredRoutes = async (): Promise<string[]> => {
  const root = path.dirname(fileURLToPath(import.meta.url));
  const files = (await readdir(root, { recursive: true }))
    .filter((file) => file.endsWith(".ts") && !file.endsWith(".test.ts"));
  const routes = new Set<string>();
  for (const file of files) {
    const source = await readFile(path.join(root, file), "utf8");
    for (const match of source.matchAll(/\bapp\.(get|post|put|patch|delete)\(\s*"\/api(\/[^"]*)"/g)) {
      routes.add(`${match[1].toUpperCase()} ${match[2]}`);
    }
  }
  return [...routes].sort();
};

test("every registered route is either open to ordinary accounts or named administrator-only", async () => {
  const routes = await registeredRoutes();
  // A broken scan would pass vacuously; the server registers well over a hundred routes.
  assert.ok(routes.length > 150, `only ${routes.length} routes found`);
  const unclassified = routes.filter((route) => {
    if (ADMIN_ONLY.has(route)) return false;
    const [method, pattern] = route.split(" ");
    const sample = pattern.replace(/:([A-Za-z]+)/g, (_, name: string) => SAMPLE_PARAMS[name] ?? "x");
    return !isUserAllowed(method, sample);
  });
  assert.deepEqual(unclassified, [],
    "Add each route to USER_ALLOWED (with a viewer-scoped handler) or to ADMIN_ONLY in roles.test.ts");
  // The list stays honest: no stale entry, and nothing listed that users can in fact reach.
  for (const route of ADMIN_ONLY) {
    assert.ok(routes.includes(route), `${route} is no longer registered`);
    const [method, pattern] = route.split(" ");
    assert.ok(!isUserAllowed(method, pattern.replace(/:([A-Za-z]+)/g, "x")), `${route} is listed as admin-only but users reach it`);
  }
});
