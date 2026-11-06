import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import express from "express";
import {
  createSession,
  parseCookies,
  readSession,
  SESSION_COOKIE,
  type SessionInfo,
} from "../auth.js";
import { messageKeyOf } from "../errors.js";
import { PAIRING_INTERVAL_MS, PairingRegistry } from "../pairing.js";
import { authRequestLimiter } from "../request-limits.js";
import { passwordChangeMiddleware, roleMiddleware } from "../roles.js";
import { restrictedMiddleware } from "../restricted.js";
import { defaultInstanceSettings, Store } from "../store.js";
import { emptyUserData, findUserById, type UserRecord } from "../users.js";
import type { RouteContext } from "./context.js";
import { registerPairingRoutes } from "./pairing.js";

const OPEN = new Set(["/status", "/auth/login", "/auth/me", "/auth/setup", "/auth/pair/poll", "/auth/pair/start"]);

interface Harness {
  base: string;
  store: Store;
  user: UserRecord;
  cookie: string;
  registry: PairingRegistry;
  now: { value: number };
  accessChecks: { count: number };
  close(): Promise<void>;
}

const account = (over: Partial<UserRecord> = {}): UserRecord => ({
  id: "usr_00000001",
  username: "owner",
  passwordHash: "scrypt$aa$bb",
  secret: "pairing-route-secret",
  role: "user",
  createdAt: "2026-01-01T00:00:00.000Z",
  permissions: { downloadToLibrary: true, downloadToDevice: true },
  permissionsVersion: 0,
  ...over,
});

const mount = async (options: {
  user?: UserRecord;
  setup?: boolean;
  restricted?: boolean;
  mustChange?: boolean;
  gates?: boolean;
} = {}): Promise<Harness> => {
  const dir = await mkdtemp(path.join(tmpdir(), "routes-pairing-"));
  const user = options.user ?? account(options.mustChange ? { mustChangePassword: true } : {});
  const users = options.setup ? [] : [user];
  await writeFile(path.join(dir, "state.json"), JSON.stringify({
    schemaVersion: 3,
    addons: [],
    settings: defaultInstanceSettings(),
    defaultsInstalled: true,
    users,
    userData: Object.fromEntries(users.map((entry) => [entry.id, emptyUserData()])),
    libraries: [],
  }));
  const store = new Store(dir, dir);
  await store.load();
  const now = { value: Date.now() };
  const registry = new PairingRegistry({ now: () => now.value });
  const accessChecks = { count: 0 };
  const currentSession = (req: express.Request): SessionInfo | undefined => {
    const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
    const id = token ? readSession(user.secret, token)?.userId : undefined;
    const current = id ? findUserById(store.users(), id) : undefined;
    if (!current || current.disabled) return undefined;
    const info = readSession(current.secret, token);
    if (!info || info.userId !== current.id || current.revoked?.[info.sid]) return undefined;
    return info;
  };
  const ctx: RouteContext = {
    store,
    needsSetup: () => !store.users().length,
    currentSession,
    currentUser: (req) => {
      const info = currentSession(req);
      return info ? findUserById(store.users(), info.userId) : undefined;
    },
    isSecure: (req) => req.protocol === "https" || req.get("x-forwarded-proto") === "https",
    stopOwnedPlayback: async () => undefined,
    stopUserSessions: async () => undefined,
    requireAccess: () => { accessChecks.count += 1; },
    stopContentAccess: async () => undefined,
  };
  const app = express();
  app.set("trust proxy", true);
  app.use(express.json());
  app.use("/api/auth/pair", (_req, res, next) => {
    res.setHeader("cache-control", "private, no-store");
    res.setHeader("pragma", "no-cache");
    next();
  });
  if (options.restricted) process.env.RESTRICTED_MODE = "1";
  if (options.gates !== false) {
    app.use("/api", roleMiddleware({
      isOpen: (req) => OPEN.has(req.path),
      isInternal: () => false,
      roleOf: (req) => ctx.currentUser(req)?.role,
    }));
    app.use("/api", passwordChangeMiddleware({
      isOpen: (req) => OPEN.has(req.path),
      isInternal: () => false,
      mustChange: (req) => ctx.currentUser(req)?.mustChangePassword,
    }));
    app.use("/api", restrictedMiddleware({
      isOpen: (req) => OPEN.has(req.path),
      isInternal: () => false,
    }));
  }
  // A separate limiter, exactly like the one mounted by index.ts for password auth.
  app.post("/api/auth/login", authRequestLimiter({ userId: () => undefined }), (_req, res) => res.status(204).end());
  registerPairingRoutes(app, ctx, registry);
  app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    const status = typeof (error as { status?: unknown }).status === "number" ? (error as { status: number }).status : 400;
    const retryAfterMs = (error as { retryAfterMs?: unknown }).retryAfterMs;
    if (typeof retryAfterMs === "number" && retryAfterMs > 0) {
      res.setHeader("retry-after", String(Math.max(1, Math.ceil(retryAfterMs / 1000))));
    }
    res.status(status).json({
      error: error instanceof Error ? error.message : String(error),
      messageKey: messageKeyOf(error),
    });
  });
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;
  const cookieToken = options.setup
    ? ""
    : createSession(user.secret, user.id, now.value + 60_000, "phone-sid");
  return {
    base: `http://127.0.0.1:${port}`,
    store,
    user,
    cookie: `${SESSION_COOKIE}=${cookieToken}`,
    registry,
    now,
    accessChecks,
    close: async () => {
      delete process.env.RESTRICTED_MODE;
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(dir, { recursive: true, force: true });
    },
  };
};

interface RequestOptions {
  body?: unknown;
  cookie?: string;
  headers?: Record<string, string>;
  contentType?: string;
}

const api = (harness: Harness, pathname: string, options: RequestOptions = {}) =>
  fetch(`${harness.base}${pathname}`, {
    method: "POST",
    headers: {
      "content-type": options.contentType ?? "application/json",
      ...(options.cookie ? { cookie: options.cookie } : {}),
      ...options.headers,
    },
    body: typeof options.body === "string" ? options.body : JSON.stringify(options.body ?? {}),
  });

const keyOf = async (response: Response) => ((await response.json()) as { messageKey?: string }).messageKey;

const start = async (harness: Harness) => {
  const response = await api(harness, "/api/auth/pair/start", { body: { deviceLabel: "Living room TV" } });
  assert.equal(response.status, 201);
  return await response.json() as { code: string; pollToken: string; expiresIn: number; interval: number };
};

const inspect = async (harness: Harness, code: string, headers: Record<string, string> = { "x-pairing-intent": "approve" }) => {
  const response = await api(harness, "/api/auth/pair/inspect", {
    cookie: harness.cookie,
    headers,
    body: { code },
  });
  return response;
};

test("start and poll are public, private and do not expose either secret outside its channel", async (t) => {
  const harness = await mount();
  t.after(harness.close);
  const response = await api(harness, "/api/auth/pair/start", { body: { deviceLabel: "  Bedroom TV  " } });
  assert.equal(response.status, 201);
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  const started = await response.json() as { code: string; pollToken: string; expiresIn: number; interval: number };
  assert.match(started.code, /^[0-9A-HJKMNP-TV-Z]{8}$/);
  assert.equal(started.pollToken.length, 43);
  assert.deepEqual({ expiresIn: started.expiresIn, interval: started.interval }, { expiresIn: 300, interval: 5 });
  const body = JSON.stringify(started);
  assert.equal(body.includes("Living"), false);

  const pending = await api(harness, "/api/auth/pair/poll", { body: { pollToken: started.pollToken } });
  assert.equal(pending.status, 200);
  assert.deepEqual(await pending.json(), { status: "pending" });
  assert.equal(pending.headers.get("set-cookie"), null);
  assert.equal(pending.headers.get("cache-control"), "private, no-store");
});

test("the ordinary-user flow inspects, explicitly approves, then delivers and replays one cookie", async (t) => {
  const harness = await mount();
  t.after(harness.close);
  const started = await start(harness);
  const preview = await inspect(harness, `${started.code.slice(0, 4).toLowerCase()} ${started.code.slice(4)}`);
  assert.equal(preview.status, 200);
  assert.equal(preview.headers.get("cache-control"), "private, no-store");
  const body = await preview.json() as { code: string; deviceLabel: string; username: string; nonce: string; expiresIn: number };
  assert.equal(body.code, started.code);
  assert.equal(body.deviceLabel, "Living room TV");
  assert.equal(body.username, "owner");
  assert.equal(body.nonce.length, 43);
  assert.equal(body.expiresIn, 300);
  assert.equal(JSON.stringify(body).includes(harness.user.secret), false);

  const approved = await api(harness, "/api/auth/pair/approve", {
    cookie: harness.cookie,
    headers: { "x-pairing-intent": "approve" },
    body: { code: started.code, nonce: body.nonce },
  });
  assert.equal(approved.status, 204);
  assert.equal(approved.headers.get("cache-control"), "private, no-store");
  assert.equal(approved.headers.get("set-cookie"), null);

  harness.now.value += PAIRING_INTERVAL_MS;
  const delivered = await api(harness, "/api/auth/pair/poll", { body: { pollToken: started.pollToken } });
  assert.equal(delivered.status, 200);
  assert.equal(delivered.headers.get("cache-control"), "private, no-store");
  const deliveredBody = await delivered.clone().json();
  assert.deepEqual(deliveredBody, {
    status: "approved",
    username: "owner",
    role: "user",
    language: "en",
  });
  const firstCookie = delivered.headers.get("set-cookie");
  assert.ok(firstCookie);
  const firstToken = parseCookies(firstCookie)[SESSION_COOKIE];
  assert.ok(firstToken);
  assert.equal(readSession(harness.user.secret, firstToken)?.userId, harness.user.id);
  assert.equal(JSON.stringify(deliveredBody).includes(firstToken), false);

  harness.now.value += PAIRING_INTERVAL_MS;
  const replay = await api(harness, "/api/auth/pair/poll", {
    body: { pollToken: started.pollToken },
    headers: { "x-forwarded-proto": "https" },
  });
  assert.equal(replay.status, 200);
  const replayCookie = replay.headers.get("set-cookie");
  assert.ok(replayCookie);
  assert.equal(parseCookies(replayCookie)[SESSION_COOKIE], firstToken);
  assert.match(replayCookie, /;\s*Secure(?:;|$)/);
  assert.ok(harness.accessChecks.count >= 2, "approval checks requireAccess in the route context");
});

test("per-record polling gets retry-after and never extends the original deadline", async (t) => {
  const harness = await mount();
  t.after(harness.close);
  const started = await start(harness);
  assert.equal((await api(harness, "/api/auth/pair/poll", { body: { pollToken: started.pollToken } })).status, 200);
  const early = await api(harness, "/api/auth/pair/poll", { body: { pollToken: started.pollToken } });
  assert.equal(early.status, 429);
  assert.equal(await keyOf(early), "err.tooManyRequests");
  assert.equal(early.headers.get("retry-after"), "5");
  assert.equal(early.headers.get("set-cookie"), null);
  assert.equal(early.headers.get("cache-control"), "private, no-store");
  harness.now.value += 300_000;
  const expired = await api(harness, "/api/auth/pair/poll", { body: { pollToken: started.pollToken } });
  assert.equal(expired.status, 410);
  assert.equal(await keyOf(expired), "err.pairInvalid");
});

test("unknown, denied and expired pairing answers are one terminal translation", async (t) => {
  const harness = await mount();
  t.after(harness.close);
  const unknown = await api(harness, "/api/auth/pair/poll", { body: { pollToken: "A".repeat(43) } });
  assert.equal(unknown.status, 410);
  assert.equal(await keyOf(unknown), "err.pairInvalid");

  const started = await start(harness);
  const preview = await inspect(harness, started.code);
  const { nonce } = await preview.json() as { nonce: string };
  assert.equal((await api(harness, "/api/auth/pair/deny", {
    cookie: harness.cookie,
    headers: { "x-pairing-intent": "approve" },
    body: { code: started.code, nonce },
  })).status, 204);
  const denied = await api(harness, "/api/auth/pair/poll", { body: { pollToken: started.pollToken } });
  assert.equal(denied.status, 410);
  assert.equal(await keyOf(denied), "err.pairInvalid");
});

test("browser approvals require JSON, the custom intent and no cross-site fetch metadata", async (t) => {
  const harness = await mount();
  t.after(harness.close);
  const started = await start(harness);

  const form = await api(harness, "/api/auth/pair/inspect", {
    cookie: harness.cookie,
    contentType: "application/x-www-form-urlencoded",
    body: `code=${started.code}`,
    headers: { "x-pairing-intent": "approve" },
  });
  assert.equal(form.status, 415);
  assert.equal(await keyOf(form), "err.invalidRequest");
  assert.equal(form.headers.get("cache-control"), "private, no-store");

  const missing = await inspect(harness, started.code, {});
  assert.equal(missing.status, 403);
  assert.equal(await keyOf(missing), "err.notAllowed");
  const cross = await inspect(harness, started.code, { "x-pairing-intent": "approve", "sec-fetch-site": "cross-site" });
  assert.equal(cross.status, 403);
  const sameSite = await inspect(harness, started.code, { "x-pairing-intent": "approve", "sec-fetch-site": "same-site" });
  assert.equal(sameSite.status, 403);
  const sameOrigin = await inspect(harness, started.code, { "x-pairing-intent": "approve", "sec-fetch-site": "same-origin" });
  assert.equal(sameOrigin.status, 200);
  const legacy = await inspect(harness, started.code, { "x-pairing-intent": "approve" });
  assert.equal(legacy.status, 200);
});

test("inspect/approve/deny enforce the account and password-change gates themselves", async (t) => {
  const mustChange = await mount({ mustChange: true, gates: false });
  t.after(mustChange.close);
  const started = await start(mustChange);
  for (const path of ["inspect", "approve", "deny"]) {
    const blocked = await api(mustChange, `/api/auth/pair/${path}`, {
      cookie: mustChange.cookie,
      headers: { "x-pairing-intent": "approve" },
      body: { code: started.code, nonce: "A".repeat(43) },
    });
    assert.equal(blocked.status, 403, path);
    assert.equal(await keyOf(blocked), "err.mustChangePassword", path);
  }

  const signedOutHarness = await mount({ gates: false });
  t.after(signedOutHarness.close);
  const signedOutStart = await start(signedOutHarness);
  for (const path of ["inspect", "approve", "deny"]) {
    const signedOut = await api(signedOutHarness, `/api/auth/pair/${path}`, {
      headers: { "x-pairing-intent": "approve" },
      body: { code: signedOutStart.code, nonce: "A".repeat(43) },
    });
    assert.equal(signedOut.status, 401, path);
    assert.equal(await keyOf(signedOut), "err.notSignedIn", path);
  }
});

test("setup cannot issue a code", async (t) => {
  const harness = await mount({ setup: true });
  t.after(harness.close);
  const response = await api(harness, "/api/auth/pair/start", { body: { deviceLabel: "TV" } });
  assert.equal(response.status, 409);
  assert.equal(await keyOf(response), "err.noAccount");
  assert.equal(response.headers.get("cache-control"), "private, no-store");
});

test("restricted mode denies public start and poll in their handlers and approvals by policy", async (t) => {
  const harness = await mount({ restricted: true });
  t.after(harness.close);
  const direct = harness.registry.start("Pre-created TV");
  for (const [path, body] of [
    ["/api/auth/pair/start", { deviceLabel: "TV" }],
    ["/api/auth/pair/poll", { pollToken: direct.pollToken }],
    ["/api/auth/pair/approve", { code: direct.code, nonce: "A".repeat(43) }],
  ] as const) {
    const response = await api(harness, path, {
      cookie: harness.cookie,
      headers: { "x-pairing-intent": "approve" },
      body,
    });
    assert.equal(response.status, 403, path);
    assert.equal(await keyOf(response), "err.restricted", path);
    assert.equal(response.headers.get("cache-control"), "private, no-store", path);
  }
});

test("the start limiter has its own bounded store and does not exhaust the password limiter", async (t) => {
  const harness = await mount();
  t.after(harness.close);
  for (let index = 0; index < 20; index += 1) {
    assert.equal((await api(harness, "/api/auth/pair/start", { body: { deviceLabel: `TV ${index}` } })).status, 201);
  }
  assert.equal((await api(harness, "/api/auth/pair/start", { body: { deviceLabel: "one too many" } })).status, 429);
  const login = await api(harness, "/api/auth/login", { body: { username: "owner", password: "wrong" } });
  assert.equal(login.status, 204);
});

test("a start keyed by IP ignores a supplied session cookie", async (t) => {
  const harness = await mount();
  t.after(harness.close);
  const starts = await Promise.all(Array.from({ length: 20 }, (_, index) =>
    api(harness, "/api/auth/pair/start", { cookie: index % 2 ? harness.cookie : "", body: { deviceLabel: `TV ${index}` } })));
  assert.equal(starts.filter((response) => response.status === 201).length, 20);
  assert.equal((await api(harness, "/api/auth/pair/start", { cookie: harness.cookie, body: { deviceLabel: "21" } })).status, 429);
});
