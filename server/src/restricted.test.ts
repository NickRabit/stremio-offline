import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import type { Request, Response } from "express";
import {
  ALLOWED_MUTATIONS,
  DENIED_GETS,
  RestrictedError,
  isAllowedMutation,
  isDeniedGet,
  logoutDenied,
  restrictedMiddleware,
  restrictedMode,
} from "./restricted.js";

const setFlag = (value: string | undefined) => {
  if (value === undefined) delete process.env.RESTRICTED_MODE;
  else process.env.RESTRICTED_MODE = value;
};

test("restrictedMode is true only for the character 1", (t) => {
  const previous = process.env.RESTRICTED_MODE;
  t.after(() => setFlag(previous));
  setFlag("1");
  assert.equal(restrictedMode(), true);
  for (const value of ["0", "", "true", "yes", "on"] as const) {
    setFlag(value);
    assert.equal(restrictedMode(), false, value);
  }
  setFlag(undefined);
  assert.equal(restrictedMode(), false);
});

test("RestrictedError is a 403 with err.restricted", () => {
  const error = new RestrictedError();
  assert.equal(error.status, 403);
  assert.equal(error.messageKey, "err.restricted");
  assert.equal(error.message, "This instance is in restricted mode.");
});

test("secret GETs match DENIED_GETS and ordinary GETs do not", () => {
  assert.equal(isDeniedGet("GET", "/addons/abc/export"), true);
  assert.equal(isDeniedGet("GET", "/settings/export"), true);
  assert.equal(isDeniedGet("GET", "/logs"), true);
  assert.equal(isDeniedGet("GET", "/diagnostics"), true);
  assert.equal(isDeniedGet("GET", "/addons"), false);
  assert.equal(isDeniedGet("GET", "/catalogs"), false);
  assert.equal(isDeniedGet("GET", "/downloads"), false);
  assert.equal(isDeniedGet("GET", "/watchlist"), false);
  assert.equal(isDeniedGet("GET", "/playback/x/1/master.m3u8"), false);
  assert.equal(isDeniedGet("POST", "/settings/export"), false);
  assert.equal(isDeniedGet("GET", "/libraries/browse"), true, "the picker names directories on the host");
  assert.equal(isDeniedGet("GET", "/libraries/grants"), true);
  assert.equal(isDeniedGet("GET", "/libraries"), false, "the list stays readable, minus the roots");
});

test("ALLOWED_MUTATIONS covers the demo writes and omits configuration", () => {
  assert.equal(isAllowedMutation("POST", "/auth/logout"), true);
  assert.equal(isAllowedMutation("POST", "/watchlist"), true);
  assert.equal(isAllowedMutation("PATCH", "/views"), true);
  assert.equal(isAllowedMutation("POST", "/progress"), true);
  assert.equal(isAllowedMutation("DELETE", "/progress/movie:tt1"), true);
  assert.equal(isAllowedMutation("POST", "/library/favorite"), true);
  assert.equal(isAllowedMutation("POST", "/library/source"), true);
  assert.equal(isAllowedMutation("POST", "/library/rename"), true);
  assert.equal(isAllowedMutation("POST", "/library/move"), true);
  assert.equal(isAllowedMutation("POST", "/library/match"), true);
  assert.equal(isAllowedMutation("POST", "/library/scan"), true);
  assert.equal(isAllowedMutation("POST", "/library/scan/stop"), true);
  assert.equal(isAllowedMutation("DELETE", "/library/suggestion"), true);
  assert.equal(isAllowedMutation("DELETE", "/library/item"), true);
  assert.equal(isAllowedMutation("POST", "/downloads"), true);
  assert.equal(isAllowedMutation("POST", "/downloads/bulk"), true);
  assert.equal(isAllowedMutation("POST", "/downloads/job-1/pause"), true);
  assert.equal(isAllowedMutation("POST", "/downloads/job-1/resume"), true);
  assert.equal(isAllowedMutation("POST", "/downloads/job-1/retry"), true);
  assert.equal(isAllowedMutation("POST", "/downloads/job-1/move"), true);
  assert.equal(isAllowedMutation("DELETE", "/downloads/job-1"), true);
  assert.equal(isAllowedMutation("DELETE", "/downloads"), true);
  assert.equal(isAllowedMutation("POST", "/device-download"), true);
  assert.equal(isAllowedMutation("POST", "/client-log"), true);
  assert.equal(isAllowedMutation("POST", "/inspect"), true);
  assert.equal(isAllowedMutation("POST", "/playback"), true);
  assert.equal(isAllowedMutation("POST", "/playback/abc/ping"), true);
  assert.equal(isAllowedMutation("POST", "/playback/abc/seek"), true);
  assert.equal(isAllowedMutation("POST", "/playback/abc/escalate"), true);
  assert.equal(isAllowedMutation("POST", "/playback/abc/track"), true);
  assert.equal(isAllowedMutation("DELETE", "/playback/abc"), true);

  assert.equal(isAllowedMutation("POST", "/addons"), false);
  assert.equal(isAllowedMutation("PATCH", "/settings"), false);
  assert.equal(isAllowedMutation("PATCH", "/auth/password"), false);
  assert.equal(isAllowedMutation("DELETE", "/progress"), false);
  assert.equal(isAllowedMutation("POST", "/settings/import"), false);
  assert.equal(isAllowedMutation("DELETE", "/logs"), false);
});

test("logoutDenied blocks only everywhere:true while the flag is on", (t) => {
  const previous = process.env.RESTRICTED_MODE;
  t.after(() => setFlag(previous));
  setFlag("1");
  assert.equal(logoutDenied({ everywhere: true }), true);
  assert.equal(logoutDenied({ everywhere: false }), false);
  assert.equal(logoutDenied({}), false);
  assert.equal(logoutDenied(undefined), false);
  setFlag("0");
  assert.equal(logoutDenied({ everywhere: true }), false);
});

const invoke = (method: string, path: string, opts?: { isOpen?: boolean; isInternal?: boolean }) => {
  let passed: unknown = "not-called";
  restrictedMiddleware({
    isOpen: () => Boolean(opts?.isOpen),
    isInternal: () => Boolean(opts?.isInternal),
  })({ method, path } as Request, {} as Response, ((error?: unknown) => { passed = error; }) as () => void);
  return passed;
};

test("middleware is a no-op when the flag is off", (t) => {
  const previous = process.env.RESTRICTED_MODE;
  t.after(() => setFlag(previous));
  setFlag("0");
  assert.equal(invoke("POST", "/addons"), undefined);
  assert.equal(invoke("GET", "/addons/x/export"), undefined);
});

test("middleware fail-closes writes and secret GETs when the flag is on", (t) => {
  const previous = process.env.RESTRICTED_MODE;
  t.after(() => setFlag(previous));
  setFlag("1");
  const denied = invoke("POST", "/addons");
  assert.ok(denied instanceof RestrictedError);
  assert.ok(invoke("PATCH", "/settings") instanceof RestrictedError);
  assert.ok(invoke("PATCH", "/auth/password") instanceof RestrictedError);
  assert.ok(invoke("DELETE", "/progress") instanceof RestrictedError);
  assert.ok(invoke("GET", "/addons/x/export") instanceof RestrictedError);
  assert.ok(invoke("GET", "/settings/export") instanceof RestrictedError);
  assert.ok(invoke("GET", "/logs") instanceof RestrictedError);
  assert.ok(invoke("GET", "/diagnostics") instanceof RestrictedError);
  assert.equal(invoke("GET", "/addons"), undefined);
  assert.equal(invoke("GET", "/catalogs"), undefined);
  assert.equal(invoke("GET", "/downloads"), undefined);
  assert.equal(invoke("POST", "/downloads"), undefined);
  assert.equal(invoke("POST", "/auth/logout"), undefined);
  assert.equal(invoke("POST", "/addons", { isOpen: true }), undefined);
  assert.equal(invoke("GET", "/media/abc", { isInternal: true }), undefined);
});

type Kind = "OPEN" | "DENIED_GETS" | "ALLOWED_MUTATIONS" | "ALLOW_GET" | "IMPLICIT_DENY" | "IGNORE";
type Parsed = { method: string; path: string; raw: string };

const IGNORE_PATHS = new Set(["/api/proxy", "/api/subtitle", "/api/library/file", "/{*path}"]);
const OPEN_PATHS = new Set(["/status", "/auth/login", "/auth/me", "/auth/setup"]);

const parseRoutes = (source: string): Parsed[] => {
  const routes: Parsed[] = [];
  const pattern = /app\.(get|post|patch|delete|all)\(\s*/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(source))) {
    const method = match[1].toUpperCase();
    const rest = source.slice(match.index + match[0].length).trimStart();
    if (rest.startsWith("[")) {
      const end = rest.indexOf("]");
      if (end < 0) throw new Error(`unparseable route array at index ${match.index}`);
      const paths = [...rest.slice(0, end + 1).matchAll(/"([^"]+)"/g)].map((item) => item[1]);
      if (!paths.length) throw new Error(`unparseable route array at index ${match.index}`);
      for (const path of paths) routes.push({ method, path, raw: match[0] });
      continue;
    }
    const quoted = rest.match(/^"([^"]+)"/);
    if (!quoted) throw new Error(`unparseable route at index ${match.index}: ${rest.slice(0, 80)}`);
    routes.push({ method, path: quoted[1], raw: match[0] });
  }
  return routes;
};

const classify = (route: Parsed): Kind => {
  if (IGNORE_PATHS.has(route.path)) return "IGNORE";
  if (!route.path.startsWith("/api/")) return "IGNORE";
  const stripped = route.path.slice("/api".length);
  if (OPEN_PATHS.has(stripped)) return "OPEN";
  if (route.method === "GET" && isDeniedGet("GET", stripped)) return "DENIED_GETS";
  if (route.method !== "GET" && route.method !== "ALL" && isAllowedMutation(route.method, stripped)) return "ALLOWED_MUTATIONS";
  if (route.method === "GET") return "ALLOW_GET";
  return "IMPLICIT_DENY";
};

test("index.ts route catalogue: implicit deny passes, orphan allow/deny regexes fail", () => {
  // Every file that registers a route, not only index.ts. The catalogue is a
  // security guard: left reading index.ts alone it would keep passing while
  // covering less with each area that moves into routes/.
  const here = path.dirname(fileURLToPath(import.meta.url));
  const indexSource = readFileSync(path.join(here, "index.ts"), "utf8");
  const routeFiles = readdirSync(path.join(here, "routes")).filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts"));
  assert.ok(routeFiles.length, "routes/ must hold the modules the routes moved into");
  const source = [indexSource, ...routeFiles.map((name) => readFileSync(path.join(here, "routes", name), "utf8"))].join("\n");
  const openLiteral = indexSource.match(/const OPEN_PATHS = new Set\(\[([^\]]+)\]\)/);
  assert.ok(openLiteral, "OPEN_PATHS must be readable from index.ts");
  const listed = [...openLiteral[1].matchAll(/"([^"]+)"/g)].map((item) => item[1]);
  assert.deepEqual(new Set(listed), OPEN_PATHS);

  const routes = parseRoutes(source);
  assert.ok(routes.length > 40, `expected a full /api surface, got ${routes.length}`);

  const byKind = new Map<Kind, Parsed[]>();
  for (const route of routes) {
    const kind = classify(route);
    const bucket = byKind.get(kind) ?? [];
    bucket.push(route);
    byKind.set(kind, bucket);
  }

  assert.ok((byKind.get("IMPLICIT_DENY") ?? []).some((route) => route.path === "/api/addons" && route.method === "POST"));
  assert.ok((byKind.get("IMPLICIT_DENY") ?? []).some((route) => route.path === "/api/settings" && route.method === "PATCH"));
  assert.ok((byKind.get("IMPLICIT_DENY") ?? []).some((route) => route.path === "/api/addons/refresh" && route.method === "POST"));
  assert.ok((byKind.get("IMPLICIT_DENY") ?? []).some((route) => route.path === "/api/addons/:key/refresh" && route.method === "POST"));
  assert.ok((byKind.get("DENIED_GETS") ?? []).some((route) => route.path === "/api/addons/:key/export"));
  assert.ok((byKind.get("ALLOWED_MUTATIONS") ?? []).some((route) => route.path === "/api/downloads" && route.method === "POST"));
  assert.ok((byKind.get("IGNORE") ?? []).some((route) => route.path === "/api/proxy"));
  assert.ok((byKind.get("IGNORE") ?? []).some((route) => route.path === "/{*path}"));
  assert.equal((byKind.get("OPEN") ?? []).length, 4);

  const apiRoutes = routes.filter((route) => route.path.startsWith("/api/") && !IGNORE_PATHS.has(route.path));
  for (const rule of ALLOWED_MUTATIONS) {
    assert.ok(
      apiRoutes.some((route) => route.method === rule.method && rule.pattern.test(route.path.slice("/api".length))),
      `orphan ALLOWED_MUTATIONS ${rule.method} ${rule.pattern}`,
    );
  }
  for (const rule of DENIED_GETS) {
    assert.ok(
      apiRoutes.some((route) => route.method === "GET" && rule.pattern.test(route.path.slice("/api".length))),
      `orphan DENIED_GETS ${rule.pattern}`,
    );
  }
  for (const route of apiRoutes) {
    if (route.method === "GET" && route.path.includes("export")) {
      assert.equal(classify(route), "DENIED_GETS", `${route.path} contains export but is not denied`);
    }
  }
});
