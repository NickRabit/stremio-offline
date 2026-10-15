/**
 * Fixtures for the production media-client verification runner. Everything the
 * runner needs that is not a check: the private fixture file, the observed
 * loopback proxy in front of a real provider, a generated Jellyfin/Emby
 * catalogue, and a disposable build of the application itself.
 *
 * Node built-ins only. The observed proxy speaks the same wire protocol the
 * production transport does (see server/src/media-server-security.ts) and
 * refuses every mutation but `POST /Users/AuthenticateByName`, so its refusal
 * counts are evidence about the application, not about the fixture.
 */
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { cp, mkdir, mkdtemp, open, rm, symlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";

export const LOOPBACK_HOST = "127.0.0.1";
export const OBSERVER_LANE_HEADER = "x-mcv-lane";
export const FIXTURE_LANE = "fixture";
export const MAX_SYNTHETIC_ITEMS = 100_000;
export const MAX_SYNTHETIC_PAGES = 200;
export const MAX_DELAY_MS = 60_000;
export const MAX_UPSTREAM_PAGE_SIZE = 200;

/** A failure the operator has to fix: a bad fixture file, a bad flag, a missing build. */
export class FixtureError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "FixtureError";
    this.code = code;
  }
}

const fail = (code, message) => {
  throw new FixtureError(code, message);
};

const sha256 = (value) => createHash("sha256").update(value).digest("hex");

/** A short, stable label for a private identifier, so a report stays useful without
 *  carrying the identifier itself. */
export const labelHash = (value) => sha256(String(value)).slice(0, 12);

export const sha256Hex = (value) => sha256(value);

/** Loopback, in the spellings the address policy of the server accepts. */
export function isLoopbackHost(host) {
  if (typeof host !== "string" || host.length === 0) return false;
  const bare = host.replace(/^\[|\]$/g, "").toLowerCase();
  if (bare === "localhost" || bare === "::1") return true;
  return net.isIPv4(bare) && bare.startsWith("127.");
}

/**
 * One upstream origin the runner may drive. Only loopback, only http(s), never
 * credentials inside the address: the runner must not be able to point itself at
 * anything the operator did not put on this machine.
 */
export function parseUpstreamUrl(raw, field = "baseUrl") {
  if (typeof raw !== "string" || raw.trim() === "") fail("invalid-upstream", `${field} is required`);
  let url;
  try {
    url = new URL(raw.trim());
  } catch {
    fail("invalid-upstream", `${field} is not a URL`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") fail("invalid-upstream", `${field} must be http or https`);
  if (url.username || url.password) fail("invalid-upstream", `${field} must not carry credentials`);
  if (url.search || url.hash) fail("invalid-upstream", `${field} must not carry a query or fragment`);
  if (!isLoopbackHost(url.hostname)) fail("invalid-upstream", `${field} must be a loopback address`);
  const base = `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
  return base;
}

const PROVIDERS = ["jellyfin", "emby"];
const UPSTREAM_ID_MAX = 512;

/**
 * The private fixture file the coordinator supplies:
 *   { providers: [{ provider, baseUrl, username, password, itemIds: [...] }] }
 * Only the item ids listed here are ever touched, and never more than a bounded
 * number of them.
 */
export function validateFixtureConfig(raw) {
  const source = typeof raw === "string" ? JSON.parse(raw) : raw;
  if (typeof source !== "object" || source === null || Array.isArray(source)) fail("invalid-fixture", "the fixture must be an object");
  if (!Array.isArray(source.providers) || source.providers.length === 0) fail("invalid-fixture", "the fixture needs at least one provider");
  if (source.providers.length > 8) fail("invalid-fixture", "the fixture has too many providers");
  const providers = source.providers.map((entry, index) => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) fail("invalid-fixture", `provider ${index + 1} is malformed`);
    if (!PROVIDERS.includes(entry.provider)) fail("invalid-fixture", `provider ${index + 1} is not jellyfin or emby`);
    const baseUrl = parseUpstreamUrl(entry.baseUrl, `provider ${index + 1} baseUrl`);
    if (typeof entry.username !== "string" || entry.username.length === 0 || entry.username.length > 256) {
      fail("invalid-fixture", `provider ${index + 1} has no usable username`);
    }
    if (typeof entry.password !== "string" || entry.password.length === 0 || entry.password.length > 1024) {
      fail("invalid-fixture", `provider ${index + 1} has no usable password`);
    }
    if (!Array.isArray(entry.itemIds) || entry.itemIds.length === 0) fail("invalid-fixture", `provider ${index + 1} lists no item ids`);
    if (entry.itemIds.length > 32) fail("invalid-fixture", `provider ${index + 1} lists too many item ids`);
    const itemIds = entry.itemIds.map((value) => {
      if (typeof value !== "string" || value.length === 0 || value.length > UPSTREAM_ID_MAX) {
        fail("invalid-fixture", `provider ${index + 1} has a malformed item id`);
      }
      return value;
    });
    return { provider: entry.provider, baseUrl, username: entry.username, password: entry.password, itemIds };
  });
  return { providers };
}

const USAGE_MODES = ["fixture", "synthetic", "help"];

const positiveInt = (value, name, max) => {
  if (!/^\d+$/.test(String(value))) fail("invalid-flag", `${name} must be a whole number`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > max) fail("invalid-flag", `${name} must be between 0 and ${max}`);
  return parsed;
};

/**
 * The command line. Nothing is inferred from the environment: a run either names
 * a private fixture or asks for the generated catalogue, and every control has a
 * validated bound before a socket is opened.
 */
export function parseRunnerArgs(argv) {
  const args = [...argv];
  const config = { mode: "none", fixturePath: undefined, outputPath: undefined, items: 600, pages: 6, delayMs: 0 };
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    const value = args[index + 1];
    const take = () => {
      if (value === undefined || value.startsWith("--")) fail("invalid-flag", `${flag} needs a value`);
      index += 1;
      return value;
    };
    switch (flag) {
      case "--fixture": config.fixturePath = take(); config.mode = "fixture"; break;
      case "--synthetic": config.mode = "synthetic"; break;
      case "--output": config.outputPath = take(); break;
      case "--items": config.items = positiveInt(take(), "--items", MAX_SYNTHETIC_ITEMS); break;
      case "--pages": config.pages = positiveInt(take(), "--pages", MAX_SYNTHETIC_PAGES); break;
      case "--delay-ms": config.delayMs = positiveInt(take(), "--delay-ms", MAX_DELAY_MS); break;
      case "--help":
      case "-h": config.mode = "help"; break;
      default: fail("invalid-flag", `unknown flag ${flag}`);
    }
  }
  if (config.mode === "none") {
    if (args.length === 0) return { ...config, mode: "help" };
    fail("invalid-flag", "choose --fixture <path> or --synthetic");
  }
  if (!USAGE_MODES.includes(config.mode)) fail("invalid-flag", `unsupported mode ${config.mode}`);
  if (config.mode === "help") return config;
  if (config.mode === "fixture" && !config.fixturePath) fail("invalid-flag", "--fixture mode needs --fixture <path>");
  if (config.mode === "synthetic" && config.fixturePath) fail("invalid-flag", "--synthetic takes no --fixture");
  if (config.mode === "synthetic" && config.items < 1) fail("invalid-flag", "--items must be at least 1");
  if (config.mode === "synthetic" && config.pages < 1) fail("invalid-flag", "--pages must be at least 1");
  if (!config.outputPath) fail("invalid-flag", "--output <report.json> is required");
  return config;
}

export function usageText() {
  return `Production media-client verification (Jellyfin/Emby playback and large libraries).

Usage:
  node scripts/media-client-verification.mjs --fixture <private.json> --output <report.json>
  node scripts/media-client-verification.mjs --synthetic --items <count> --pages <count> --delay-ms <n> --output <report.json>
  node scripts/media-client-verification.mjs --help

Options:
  --fixture <path>   Private provider file, {providers:[{provider,baseUrl,username,password,itemIds}]}.
                     Only loopback base URLs are accepted and only the listed item ids are read.
  --synthetic        Run the generated large-catalogue profile against an in-process Jellyfin server.
  --items <count>    Synthetic catalogue size, 1..${MAX_SYNTHETIC_ITEMS} (default 600).
  --pages <count>    Browse pages to traverse, 1..${MAX_SYNTHETIC_PAGES} (default 6).
  --delay-ms <n>     Controlled upstream latency for the fault scenarios, 0..${MAX_DELAY_MS} (default 0).
  --output <path>    Where the JSON report is written. Required.

The runner always starts its own disposable application on a free loopback port
with an empty data directory; it never talks to a running instance, and it never
prints credentials. Reports carry aggregates and labelled synthetic cases only.
`;
}

/** A free loopback port. The runner never reuses 8090/8091/18099. */
export async function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, LOOPBACK_HOST, () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

const MUTATION_KINDS = [
  [/^\/Sessions\b/i, "sessions"],
  [/^\/Users\/[^/]+\/PlayedItems\b/i, "userdata"],
  [/^\/Users\/[^/]+\/FavoriteItems\b/i, "userdata"],
  [/^\/Users\/[^/]+\/Items\/[^/]+\/UserData\b/i, "userdata"],
  [/Refresh/i, "refresh"],
  [/^\/System\/(Configuration|Info\/Restart|Restart)\b/i, "system"],
  [/^\/Users\/(New|Public)?$/i, "users"],
  [/^\/Users\/[^/]+\/Policy\b/i, "users"],
];

/** Which provider mutation a refused request would have been, for the report. */
export function mutationKind(pathname) {
  for (const [pattern, kind] of MUTATION_KINDS) if (pattern.test(pathname)) return kind;
  return "other";
}

/**
 * Classify one provider request into a category a report may carry. Returns
 * `allowed: false` for everything but `GET`, `HEAD` and the one authentication
 * POST, so the observer can refuse a mutation before it reaches the provider.
 */
export function classifyUpstreamRequest({ method, path: pathname, search = "" }) {
  const verb = String(method ?? "").toUpperCase();
  const clean = String(pathname ?? "");
  if (verb === "POST" && /^\/Users\/AuthenticateByName\/?$/i.test(clean)) return { category: "authentication", allowed: true };
  if (verb !== "GET" && verb !== "HEAD") {
    return { category: "prohibited", allowed: false, mutation: mutationKind(clean) };
  }
  const query = String(search ?? "");
  if (/^\/System\/Info\b/i.test(clean)) return { category: "info", allowed: true };
  if (/^\/Users\/[^/]+\/Views\/?$/i.test(clean)) return { category: "views", allowed: true };
  if (/^\/Users\/[^/]+\/Items\/[^/]+\/?$/i.test(clean)) return { category: "detail", allowed: true };
  if (/^\/Users\/[^/]+\/Items\/?$/i.test(clean)) {
    const match = /AnyProviderIdEquals|Has(Imdb|Tmdb|Tvdb)Id/i.test(query);
    return { category: match ? "match" : "listing", allowed: true };
  }
  if (/^\/Users\/[^/]+\/?$/i.test(clean)) return { category: "user", allowed: true };
  if (/^\/Items\/[^/]+\/Ancestors\b/i.test(clean)) return { category: "ancestors", allowed: true };
  if (/^\/Items\/[^/]+\/PlaybackInfo\b/i.test(clean)) return { category: "versions", allowed: true };
  if (/^\/Videos\/[^/]+\/[^/]+\/Subtitles\b/i.test(clean)) return { category: "subtitle", allowed: true };
  if (/^\/Videos\/[^/]+\/stream\b/i.test(clean)) return { category: "original", allowed: true };
  if (/^\/Items\/[^/]+\/Images\b/i.test(clean)) return { category: "artwork", allowed: true };
  return { category: "other", allowed: true };
}

const HOP_BY_HOP = new Set(["host", "connection", "keep-alive", "proxy-authorization", "proxy-connection", "te", "trailer", "transfer-encoding", "upgrade", "accept-encoding"]);

/** Response headers a relay may carry on: hop-by-hop headers and anything a proxy
 *  added are dropped, and `content-encoding` goes with the identity request. */
const RELAY_RESPONSE_DROP = new Set([...HOP_BY_HOP, "content-encoding", "set-cookie"]);

const emptyCounters = () => ({
  starts: 0, completions: 0, aborts: 0, failures: 0, refused: 0, redirects: 0,
  inFlight: 0, inFlightPeak: 0, bytes: 0, delayed: 0, delayedAborted: 0, held: 0, heldAborted: 0, heldReleased: 0,
});

const newStats = () => ({
  app: {},
  fixture: {},
  upstreamDials: {},
  faultsServed: {},
  refused: {},
});

const bucket = (stats, lane, category) => {
  const table = lane === FIXTURE_LANE ? stats.fixture : stats.app;
  table[category] ??= emptyCounters();
  return table[category];
};

const bump = (record, field, by = 1) => { record[field] = (record[field] ?? 0) + by; };

/** Write one chunk and wait for the socket to take it, without hanging on a
 *  response the client already tore down. */
const writeChunk = async (res, chunk) => {
  if (res.destroyed || res.writableEnded) return false;
  if (res.write(chunk)) return true;
  await new Promise((resolve) => {
    const finish = () => {
      res.off("drain", finish);
      res.off("close", finish);
      resolve();
    };
    res.once("drain", finish);
    res.once("close", finish);
    if (res.destroyed || res.writableEnded) finish();
  });
  return !res.destroyed && !res.writableEnded;
};

/**
 * A streaming observer in front of one loopback provider. It relays bytes
 * without buffering, never follows a redirect, counts what the application did
 * per category, and can be armed with latency and finite faults. Every child
 * socket and timer is owned by the proxy and closed by `close()`.
 */
export async function createObservedProxy(options) {
  const upstream = parseUpstreamUrl(options.upstream, "observer upstream");
  const lane = options.label ?? "provider-1";
  const maxEvents = Math.min(Math.max(options.maxEvents ?? 32, 1), 256);
  const latency = new Map();
  const faults = new Map();
  const stats = newStats();
  const events = [];
  const sockets = new Set();
  const controllers = new Set();
  const timers = new Set();
  let closed = false;

  const note = (entry) => {
    events.push({ at: Date.now(), ...entry });
    if (events.length > maxEvents) events.splice(0, events.length - maxEvents);
  };

  const sleepIn = (ms, signal) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      timers.delete(timer);
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    timers.add(timer);
    const onAbort = () => {
      clearTimeout(timer);
      timers.delete(timer);
      reject(new FixtureError("aborted", "the observer delay was aborted"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });

  /** The next armed fault for a category, or nothing. A fault with a budget of
   *  one is spent the moment it is served, so a scenario restores itself. */
  const takeFault = (category) => {
    const queue = faults.get(category);
    if (!queue || queue.length === 0) return undefined;
    const fault = queue[0];
    fault.remaining -= 1;
    if (fault.remaining <= 0) queue.shift();
    return fault;
  };

  const server = http.createServer(async (req, res) => {
    // A client that vanishes is normal here: nothing may crash the observer over it.
    req.on("error", () => undefined);
    res.on("error", () => undefined);
    const parsed = new URL(req.url ?? "/", `http://${LOOPBACK_HOST}`);
    const classified = classifyUpstreamRequest({ method: req.method, path: parsed.pathname, search: parsed.search });
    const requestLane = req.headers[OBSERVER_LANE_HEADER] === FIXTURE_LANE ? FIXTURE_LANE : "app";
    const counters = bucket(stats, requestLane, classified.category);
    counters.starts += 1;
    counters.inFlight += 1;
    counters.inFlightPeak = Math.max(counters.inFlightPeak, counters.inFlight);
    let settled = false;
    const settle = (outcome) => {
      if (settled) return;
      settled = true;
      counters.inFlight -= 1;
      if (outcome === "abort") counters.aborts += 1;
      else if (outcome === "complete") counters.completions += 1;
      else counters.failures += 1;
    };
    const abort = new AbortController();
    controllers.add(abort);
    const done = () => controllers.delete(abort);
    // A client that gives up aborts the upstream fetch and settles the counters
    // exactly once, whether it left during a delay, a hold or a streaming body.
    abort.signal.addEventListener("abort", () => { if (!settled) settle("abort"); done(); }, { once: true });
    res.once("close", () => { if (!settled) abort.abort(); done(); });
    note({ lane: requestLane, category: classified.category, method: req.method, allowed: classified.allowed });

    if (!classified.allowed) {
      counters.refused += 1;
      const kind = classified.mutation ?? "other";
      bump(stats.refused, kind);
      req.resume();
      res.statusCode = 405;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ error: "The verification observer refuses this mutation." }));
      settle("complete");
      return;
    }

    const delay = latency.get(classified.category) ?? 0;
    if (delay > 0) {
      counters.delayed += 1;
      try {
        // The upstream is never dialled for a request the client gave up on
        // while the delay was running: `abort` fires from `res.close`.
        await sleepIn(delay, abort.signal);
      } catch {
        counters.delayedAborted += 1;
        req.resume();
        settle("abort");
        return;
      }
      if (abort.signal.aborted || res.destroyed) {
        counters.delayedAborted += 1;
        req.resume();
        settle("abort");
        return;
      }
    }

    const fault = takeFault(classified.category);
    if (fault) {
      bump(stats.faultsServed, `${classified.category}:${fault.kind}`);
      req.resume();
      if (fault.kind === "status") {
        res.statusCode = fault.status;
        if (fault.retryAfterSeconds !== undefined) res.setHeader("retry-after", String(fault.retryAfterSeconds));
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ error: "A controlled provider fault." }));
        settle("complete");
        return;
      }
      if (fault.kind === "drop") {
        res.destroy();
        req.socket.destroy();
        settle("fail");
        return;
      }
      if (fault.kind === "hold") {
        counters.held += 1;
        let released = false;
        req.resume();
        const release = () => {
          if (released) return;
          released = true;
          counters.heldReleased += 1;
          res.statusCode = 200;
          res.setHeader("content-type", "application/json");
          res.end("{}");
        };
        const holdTimer = setTimeout(release, fault.maxHoldMs ?? 10_000);
        timers.add(holdTimer);
        res.once("close", () => {
          clearTimeout(holdTimer);
          timers.delete(holdTimer);
          if (!released) counters.heldAborted += 1;
        });
        return;
      }
      fail("invalid-fault", `unknown fault kind ${fault.kind}`);
    }

    const headers = {};
    for (const [name, value] of Object.entries(req.headers)) {
      const lower = name.toLowerCase();
      if (HOP_BY_HOP.has(lower) || lower === "cookie") continue;
      headers[lower] = Array.isArray(value) ? value.join(", ") : String(value ?? "");
    }
    headers["accept-encoding"] = "identity";
    const target = `${upstream}${parsed.pathname}${parsed.search}`;
    let attempted = false;
    let relayed = false;
    // The upstream exchange has its own deadline, and it covers the body: a
    // provider that answers a head and then stops talking cannot hold the slot.
    const deadlineController = new AbortController();
    const onClientAbort = () => deadlineController.abort(abort.signal.reason);
    abort.signal.addEventListener("abort", onClientAbort, { once: true });
    const deadlineTimer = setTimeout(
      () => deadlineController.abort(new FixtureError("observer-timeout", "the upstream exchange ran out of time")),
      Math.max(1_000, options.upstreamDeadlineMs ?? 120_000),
    );
    timers.add(deadlineTimer);
    try {
      const hasBody = req.method === "POST" || req.method === "PUT" || req.method === "PATCH";
      if (hasBody) headers["content-type"] ??= "application/json";
      const init = { method: req.method, headers, redirect: "manual", signal: deadlineController.signal };
      if (hasBody) { init.body = req; init.duplex = "half"; }
      // Counted where the attempt is made, so a request that dials and then fails
      // is still a dial -- and one that never dials is visibly zero.
      attempted = true;
      bump(stats.upstreamDials, classified.category);
      const upstreamResponse = await fetch(target, init);
      relayed = true;
      if (upstreamResponse.status >= 300 && upstreamResponse.status < 400) counters.redirects += 1;
      res.statusCode = upstreamResponse.status;
      for (const [name, value] of upstreamResponse.headers.entries()) {
        if (RELAY_RESPONSE_DROP.has(name.toLowerCase())) continue;
        res.setHeader(name, value);
      }
      if (!upstreamResponse.body || req.method === "HEAD") {
        await upstreamResponse.body?.cancel().catch(() => undefined);
        res.end();
        settle("complete");
        return;
      }
      const reader = upstreamResponse.body.getReader();
      for (;;) {
        const { done: finished, value } = await reader.read();
        if (finished) break;
        counters.bytes += value.byteLength;
        if (!await writeChunk(res, Buffer.from(value))) break;
      }
      res.end();
      settle("complete");
    } catch (error) {
      if (deadlineController.signal.aborted && !abort.signal.aborted) {
        note({ lane: requestLane, category: classified.category, relay: "deadline" });
      }
      if (res.destroyed || abort.signal.aborted) {
        settle("abort");
        return;
      }
      if (relayed) {
        settle("fail");
        if (!res.headersSent) {
          // The upstream's own headers were staged but never flushed. They promise a
          // length this response will not deliver, so they go before the 502 does.
          for (const name of ["content-length", "content-range", "content-type", "accept-ranges", "etag", "last-modified"]) {
            res.removeHeader(name);
          }
          res.statusCode = 502;
          res.setHeader("content-type", "application/json");
          res.end(JSON.stringify({ error: "The verification observer could not relay the request." }));
        } else res.destroy();
        return;
      }
      // Nothing was sent upstream: the provider was unreachable or the address
      // was refused. Both are a failure of the request, not of the observer.
      settle("fail");
      if (!res.headersSent) {
        res.statusCode = 502;
        res.end(JSON.stringify({ error: "The verification observer could not reach the provider." }));
      }
      note({ lane: requestLane, category: classified.category, relay: "no-response", attempted });
    } finally {
      clearTimeout(deadlineTimer);
      timers.delete(deadlineTimer);
      abort.signal.removeEventListener("abort", onClientAbort);
      done();
    }
  });

  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, LOOPBACK_HOST, () => resolve());
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  if (!port) fail("observer", "the observer did not bind a port");

  return {
    lane,
    port,
    baseUrl: `http://${LOOPBACK_HOST}:${port}`,
    /** Safe aggregates only: no paths, no addresses, no headers. */
    stats: () => JSON.parse(JSON.stringify({ ...stats, events: events.slice() })),
    counters: (category, requestLane = "app") => ({ ...(stats[requestLane === FIXTURE_LANE ? "fixture" : "app"][category] ?? emptyCounters()) }),
    /** How many times a given controlled fault was actually served, so a scenario
     *  that never reached the provider is visible instead of implied. */
    faultServed: (category, kind) => stats.faultsServed[`${category}:${kind}`] ?? 0,
    dials: (category) => stats.upstreamDials[category] ?? 0,
    setLatency: (category, ms) => {
      if (ms > 0) latency.set(category, ms); else latency.delete(category);
    },
    armFault: (category, fault) => {
      const queue = faults.get(category) ?? [];
      queue.push({ ...fault, remaining: fault.times ?? 1 });
      faults.set(category, queue);
    },
    clearFaults: (category) => faults.delete(category),
    reset: () => {
      stats.app = {};
      stats.fixture = {};
      stats.upstreamDials = {};
      stats.faultsServed = {};
      stats.refused = {};
      events.length = 0;
    },
    pending: () => {
      let total = 0;
      for (const counters of [...Object.values(stats.app), ...Object.values(stats.fixture)]) total += counters.inFlight;
      return total;
    },
    close: async () => {
      if (closed) return;
      closed = true;
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
      for (const controller of controllers) controller.abort();
      controllers.clear();
      for (const socket of sockets) socket.destroy();
      sockets.clear();
      await new Promise((resolve) => server.close(() => resolve()));
      server.closeAllConnections?.();
    },
  };
}

const SYNTHETIC_TOKEN = "synthetic-access-token";
const SYNTHETIC_LIBRARY_ID = "synthetic-library";
const SEARCH_SCAN_MAX = 10_000;

const syntheticItem = (index) => ({
  Id: `item-${String(index).padStart(7, "0")}`,
  Name: `Synthetic title ${index + 1}`,
  Type: "Movie",
  ParentId: SYNTHETIC_LIBRARY_ID,
  ImageTags: { Primary: `synthetic-tag-${index % 8}` },
  ChildCount: 0,
});

const syntheticFolder = (index) => ({
  Id: `folder-${String(index).padStart(5, "0")}`,
  Name: `Synthetic folder ${index + 1}`,
  Type: "Folder",
  ParentId: SYNTHETIC_LIBRARY_ID,
  ChildCount: 25,
});

/**
 * A Jellyfin/Emby-shaped catalogue generated on demand. Rows are built from an
 * index, so a 100 000-item library costs one page of memory and no page is ever
 * materialised to answer a count.
 */
export async function createSyntheticProvider(options = {}) {
  const total = Math.min(Math.max(options.items ?? 600, 1), MAX_SYNTHETIC_ITEMS);
  const folders = Math.min(Math.max(options.folders ?? 0, 0), 5_000);
  // Two generated servers must be two accounts as far as the application is
  // concerned, or it refuses the second one as a duplicate connection.
  const serverId = options.serverId ?? `synthetic-server-${randomBytes(4).toString("hex")}`;
  const accountId = options.accountId ?? `synthetic-account-${randomBytes(4).toString("hex")}`;
  const libraryCollectionType = folders > 0 ? "" : "movies";
  const pageDelayMs = Math.min(Math.max(options.pageDelayMs ?? 0, 0), MAX_DELAY_MS);
  const counters = { requests: 0, pages: 0, pageSizes: [], unexpected: 0, details: 0, versions: 0, ancestors: 0, auth: 0, views: 0, user: 0, info: 0, totals: [] };
  let fetched = 0;
  const sockets = new Set();
  let closed = false;

  const send = (res, status, body) => {
    const text = JSON.stringify(body);
    res.statusCode = status;
    res.setHeader("content-type", "application/json");
    res.setHeader("content-length", String(Buffer.byteLength(text)));
    res.end(text);
  };

  const readBody = (req) => new Promise((resolve) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size <= 64 * 1024) chunks.push(chunk);
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        resolve({});
      }
    });
    req.on("error", () => resolve({}));
  });

  /** One page of the generated catalogue, in catalogue order. Folder mode lists
   *  folders first and then the titles inside each folder, exactly as a native
   *  folder browse would. */
  const page = ({ startIndex, limit, parentId, recursive, search }) => {
    const inFolder = parentId !== SYNTHETIC_LIBRARY_ID && parentId !== undefined && parentId !== null && parentId !== "";
    const source = inFolder ? { kind: "folder-items", folderIndex: Number(String(parentId).replace(/^folder-/, "")) || 0 } : { kind: recursive ? "titles" : "folders" };
    const rowCount = source.kind === "titles" ? total : source.kind === "folders" ? folders : 25;
    const row = (index) => {
      if (source.kind === "titles") return syntheticItem(index);
      if (source.kind === "folders") return syntheticFolder(index);
      return { ...syntheticItem(index), ParentId: parentId, Name: `Synthetic title ${index + 1} in ${parentId}` };
    };
    if (!search) {
      // No index list is ever built: the page is generated straight from its offsets,
      // so a hundred thousand rows cost no more than one page.
      const from = Math.min(startIndex, rowCount);
      const until = Math.min(startIndex + limit, rowCount);
      const items = [];
      for (let index = from; index < until; index += 1) items.push(row(index));
      return { items, total: rowCount, rowCount };
    }
    // Search is a bounded scan: enough for a smoke check, never the whole catalogue.
    const matches = [];
    for (let index = 0; index < Math.min(rowCount, SEARCH_SCAN_MAX); index += 1) {
      if (row(index).Name.toLowerCase().includes(String(search).toLowerCase())) matches.push(index);
    }
    return { items: matches.slice(startIndex, startIndex + limit).map((index) => row(index)), total: matches.length, rowCount };
  };

  const server = http.createServer(async (req, res) => {
    counters.requests += 1;
    const parsed = new URL(req.url ?? "/", `http://${LOOPBACK_HOST}`);
    const classified = classifyUpstreamRequest({ method: req.method, path: parsed.pathname, search: parsed.search });
    if (!classified.allowed) {
      bump(counters, "unexpected");
      send(res, 405, { error: "The synthetic provider refuses mutations." });
      return;
    }
    const verb = String(req.method).toUpperCase();
    if (verb === "POST" && /^\/Users\/AuthenticateByName$/i.test(parsed.pathname)) {
      counters.auth += 1;
      const credentials = await readBody(req);
      if (!credentials.Username || !credentials.Pw) {
        send(res, 401, { error: "Credentials are required." });
        return;
      }
      send(res, 200, { User: { Id: accountId, ServerId: serverId }, AccessToken: SYNTHETIC_TOKEN });
      return;
    }
    if (/^\/System\/Info\/Public$/i.test(parsed.pathname)) {
      counters.info += 1;
      send(res, 200, { Id: serverId, Version: options.version ?? "12.2.0" });
      return;
    }
    if (/^\/Users\/[^/]+\/Views$/i.test(parsed.pathname)) {
      counters.views += 1;
      send(res, 200, {
        Items: [{
          Id: SYNTHETIC_LIBRARY_ID,
          Name: "Synthetic library",
          Type: "CollectionFolder",
          CollectionType: libraryCollectionType,
          ImageTags: { Primary: "synthetic-library-tag" },
        }],
      });
      return;
    }
    if (/^\/Users\/[^/]+\/Items\/[^/]+$/i.test(parsed.pathname)) {
      counters.details += 1;
      const id = decodeURIComponent(parsed.pathname.split("/").at(-1));
      const match = /^item-(\d+)$/.exec(id);
      send(res, 200, match ? syntheticItem(Number(match[1])) : { ...syntheticItem(0), Id: id });
      return;
    }
    if (/^\/Items\/[^/]+\/Ancestors$/i.test(parsed.pathname)) {
      counters.ancestors += 1;
      send(res, 200, [{ Id: decodeURIComponent(parsed.pathname.split("/")[2]), Type: "Movie" }, { Id: SYNTHETIC_LIBRARY_ID, Type: "CollectionFolder" }]);
      return;
    }
    if (/^\/Items\/[^/]+\/PlaybackInfo$/i.test(parsed.pathname)) {
      counters.versions += 1;
      send(res, 200, { MediaSources: [] });
      return;
    }
    if (/^\/Users\/[^/]+\/Items$/i.test(parsed.pathname)) {
      const query = parsed.searchParams;
      const limit = Math.min(Math.max(Number(query.get("Limit") ?? "60") || 60, 1), MAX_UPSTREAM_PAGE_SIZE);
      const startIndex = Math.max(Number(query.get("StartIndex") ?? "0") || 0, 0);
      const recursive = query.get("Recursive") === "true";
      const parentId = query.get("ParentId") ?? SYNTHETIC_LIBRARY_ID;
      const wantsTotal = query.get("EnableTotalRecordCount") !== "false";
      if (pageDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, pageDelayMs));
      if (closed || res.destroyed) return;
      const result = page({ startIndex, limit, parentId, recursive, search: query.get("SearchTerm") ?? undefined });
      counters.pages += 1;
      counters.pageSizes.push(limit);
      if (counters.pageSizes.length > 64) counters.pageSizes.shift();
      counters.totals.push(result.total);
      if (counters.totals.length > 64) counters.totals.shift();
      fetched += result.items.length;
      const body = { Items: result.items };
      if (wantsTotal) body.TotalRecordCount = result.total;
      send(res, 200, body);
      return;
    }
    if (/^\/Users\/[^/]+$/i.test(parsed.pathname)) {
      counters.user += 1;
      send(res, 200, {
        Id: accountId,
        Policy: { IsDisabled: false, EnableMediaPlayback: true, EnableAllFolders: true, EnabledFolders: [] },
      });
      return;
    }
    bump(counters, "unexpected");
    send(res, 404, { error: "Not part of this fixture." });
  });

  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, LOOPBACK_HOST, () => resolve());
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  if (!port) fail("synthetic", "the synthetic provider did not bind a port");

  return {
    port,
    baseUrl: `http://${LOOPBACK_HOST}:${port}`,
    provider: options.provider ?? "jellyfin",
    serverId,
    accountId,
    libraryId: SYNTHETIC_LIBRARY_ID,
    username: options.username ?? "synthetic",
    password: options.password ?? randomBytes(12).toString("hex"),
    catalogueTotal: total,
    folderTotal: folders,
    stats: () => ({ ...counters, pageSizes: counters.pageSizes.slice(), totals: counters.totals.slice(), itemsFetched: fetched }),
    close: async () => {
      if (closed) return;
      closed = true;
      for (const socket of sockets) socket.destroy();
      sockets.clear();
      await new Promise((resolve) => server.close(() => resolve()));
      server.closeAllConnections?.();
    },
  };
}

/**
 * A tiny same-origin client for the disposable application. The session cookie
 * lives here and in no report: callers only ever name a path.
 */
export function createAppClient(baseUrl, cookie) {
  /** Arm one deadline for a whole exchange. The timer covers the body too, and it
   *  is always cleared, so no request of any kind outlives its own bound. */
  const withDeadline = (options) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new FixtureError("deadline", "the request ran out of time")), options.timeoutMs ?? 30_000);
    const onAbort = () => controller.abort(options.signal?.reason);
    options.signal?.addEventListener("abort", onAbort, { once: true });
    if (options.signal?.aborted) controller.abort(options.signal.reason);
    const release = () => {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
    };
    return { controller, release };
  };

  const send = async (target, options = {}) => {
    const { method = "GET", body, headers = {} } = options;
    const { controller, release } = withDeadline(options);
    let answered = false;
    try {
      const response = await fetch(new URL(target, baseUrl), {
        method,
        signal: controller.signal,
        redirect: "manual",
        headers: {
          ...(cookie ? { cookie } : {}),
          ...(body === undefined ? {} : { "content-type": "application/json" }),
          ...headers,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      answered = true;
      // The caller reads the body; the deadline stays armed until it does.
      return { response, release };
    } finally {
      if (!answered) release();
    }
  };

  /** A buffered JSON call. The whole body is read under the deadline. */
  const request = async (target, options = {}) => {
    const { response, release } = await send(target, options);
    try {
      const buffer = Buffer.from(await response.arrayBuffer());
      return {
        status: response.status,
        headers: response.headers,
        buffer,
        text: () => buffer.toString("utf8"),
        json: () => JSON.parse(buffer.toString("utf8")),
      };
    } finally {
      release();
    }
  };

  /** A bounded byte read: a range or one segment is never buffered whole, and the
   *  deadline covers the body rather than only the response head. */
  const bytes = async (target, options = {}) => {
    const { response, release } = await send(target, { timeoutMs: 60_000, ...options });
    try {
      const bounded = await readBounded(response, options.maxBytes ?? 1 << 20);
      return { status: response.status, headers: response.headers, bytes: bounded.bytes, truncated: bounded.truncated };
    } finally {
      release();
    }
  };

  return { baseUrl, cookie, request, bytes };
}

/** Read at most `maxBytes` of a response body, so a segment read has a bound. */
export async function readBounded(response, maxBytes) {
  const body = response.body;
  if (!body) return { bytes: Buffer.alloc(0), truncated: false };
  const reader = body.getReader();
  const chunks = [];
  let size = 0;
  let truncated = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    const piece = Buffer.from(value);
    if (size + piece.length > maxBytes) {
      chunks.push(piece.subarray(0, maxBytes - size));
      size = maxBytes;
      truncated = true;
      void reader.cancel().catch(() => undefined);
      break;
    }
    chunks.push(piece);
    size += piece.length;
  }
  return { bytes: Buffer.concat(chunks), truncated };
}

const waitFor = async (probe, { deadlineMs, intervalMs = 100, label }) => {
  const deadline = Date.now() + deadlineMs;
  let last;
  for (;;) {
    try {
      const value = await probe();
      if (value) return value;
      last = "not ready";
    } catch (error) {
      last = error instanceof Error ? error.message : String(error);
    }
    if (Date.now() >= deadline) fail("timeout", `${label} did not become ready: ${last}`);
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
};

/**
 * Start one disposable application: the built server and web bundle staged in a
 * private temporary tree, an empty data directory, no addons and no automatic
 * scanning. The child's output goes to a 0600 file the runner never echoes, and
 * the whole tree is removed by `stop()`.
 */

/** The only parent variables a disposable application may inherit: what the
 *  platform needs to find its own binaries and temp directory. */
const INHERITED_ENV_ALLOW = [
  "PATH", "TMPDIR", "TMP", "TEMP", "LANG", "LC_ALL", "LC_CTYPE",
  "SystemRoot", "SystemDrive", "windir", "PATHEXT", "ComSpec", "NUMBER_OF_PROCESSORS", "PROCESSOR_ARCHITECTURE",
];

/** Every variable the application itself reads, so the record of a run can name what
 *  was deliberately not inherited. Names only; a value never leaves the parent. */
export const APP_ENV_NAMES = Object.freeze([
  "DATA_DIR", "DOWNLOAD_DIR", "PORT", "HOST", "LOG_LEVEL", "LOG_STDOUT", "LOG_MAX_BYTES", "LOG_RETENTION_DAYS",
  "LIBRARY_ROOTS", "LIBRARY_AUTO_SCAN", "LIBRARY_AUTO_SCAN_INTERVAL_MS", "LIBRARY_META_TTL_DAYS", "LIBRARY_SCAN_GAP_MS",
  "ADDON_AUTO_REFRESH", "ALLOW_PRIVATE_ADDONS", "ALLOW_ADDON_HOSTS", "ADMIN_USERNAME", "ADMIN_PASSWORD", "ADMIN_PASSWORD_RESET",
  "MEDIA_SERVER_KEY_FILE", "MEDIA_SERVER_REVALIDATE_MS", "MEDIA_SERVER_REVALIDATE_TIMEOUT_MS", "HOST_CHECK", "RESTRICTED_MODE",
  "BUILD_TIME", "GIT_COMMIT", "VAAPI_DEVICE", "VAAPI_QP", "NVENC", "NVENC_CQ", "VIDEOTOOLBOX", "VIDEOTOOLBOX_QUALITY",
  "MEDIAFOUNDATION", "MEDIAFOUNDATION_QUALITY", "FFMPEG_PRESET", "FFMPEG_CRF", "FFMPEG_BURST", "FFMPEG_READRATE",
  "FFMPEG_READRATE_REMUX", "IMAGE_CACHE_MB", "IMAGE_CACHE_TTL_DAYS", "IMAGE_CACHE_INDEX_TTL_DAYS", "IMAGE_MEMORY_MB",
  "ARTWORK_CACHE_MB", "MOSAIC_CACHE_MB", "MOSAIC_MEMORY_MB", "REMOTE_IMAGE_CACHE_MB", "REMOTE_IMAGE_MEMORY_MB",
  "THUMB_MEMORY_MB", "STREAM_ADDON_TIMEOUT_MS",
]);

/**
 * The child's environment: platform basics plus exactly what this run decides.
 * Every other variable of the parent installation -- a deployment key path, library
 * roots, an administrator password, an addon or hardware override -- is dropped.
 * Answers the environment and the app-sensitive names that were present and are not
 * being passed on.
 */
export function disposableAppEnv(base, env = process.env) {
  const child = {};
  for (const name of INHERITED_ENV_ALLOW) if (typeof env[name] === "string") child[name] = env[name];
  Object.assign(child, base);
  const stripped = APP_ENV_NAMES.filter((name) => typeof env[name] === "string");
  return { env: child, stripped };
}
export async function startDisposableApp(options) {
  const repoRoot = options.repoRoot;
  const serverEntry = path.join(repoRoot, "server", "dist", "index.js");
  const webDist = path.join(repoRoot, "web", "dist");
  if (!existsSync(serverEntry)) fail("missing-build", "server/dist/index.js is missing: run `npm run build` first");
  if (!existsSync(webDist)) fail("missing-build", "web/dist is missing: run `npm run build` first");

  const dir = await mkdtemp(path.join(os.tmpdir(), "media-client-verification-"));
  const appDir = path.join(dir, "app");
  const dataDir = path.join(dir, "data");
  const downloadDir = path.join(dir, "downloads");
  const logPath = path.join(dir, "app.log");
  try {
    await mkdir(dataDir, { recursive: true });
    await mkdir(downloadDir, { recursive: true });
    await cp(path.join(repoRoot, "server", "dist"), path.join(appDir, "server", "dist"), { recursive: true });
    // The server reads its own version from `../package.json` at runtime, as the
    // image ships it; without it /api/status would answer 0.0.0 in every report.
    await cp(path.join(repoRoot, "server", "package.json"), path.join(appDir, "server", "package.json"));
    await cp(webDist, path.join(appDir, "web"), { recursive: true });
    // The staged tree sits outside the repository, so resolution needs a link the
    // same way the built image lays its own bundles out.
    for (const [link, target] of [
      [path.join(dir, "node_modules"), path.join(repoRoot, "node_modules")],
      [path.join(appDir, "server", "node_modules"), path.join(repoRoot, "server", "node_modules")],
    ]) {
      if (!existsSync(target)) continue;
      await symlink(target, link, "dir").catch(() => undefined);
    }
    await writeFile(path.join(dataDir, "state.json"), JSON.stringify({ addons: [], defaultsInstalled: true }, null, 2));

    const port = options.port ?? await freePort();
    if (port === 8090 || port === 8091 || port === 18099) fail("reserved-port", "the runner never uses 8090/8091/18099");
    // Its own vault key and its own library roots: the child must never read a key
    // or a library the parent installation points at.
    const keyFile = path.join(dir, "media-server.key");
    const keyHandle = await open(keyFile, "wx", 0o600);
    try {
      await keyHandle.writeFile(randomBytes(32));
      await keyHandle.chmod?.(0o600);
    } finally {
      await keyHandle.close();
    }
    const libraryRoots = path.join(dir, "library-roots");
    await mkdir(libraryRoots, { recursive: true });

    const logHandle = await open(logPath, "a", 0o600);
    const { env, stripped } = disposableAppEnv({
      NODE_ENV: "production",
      PORT: String(port),
      HOST: LOOPBACK_HOST,
      DATA_DIR: dataDir,
      DOWNLOAD_DIR: downloadDir,
      MEDIA_SERVER_KEY_FILE: keyFile,
      LIBRARY_ROOTS: libraryRoots,
      LIBRARY_AUTO_SCAN: "0",
      ADDON_AUTO_REFRESH: "0",
      LOG_STDOUT: "1",
      LOG_LEVEL: options.logLevel ?? "WARN",
    });
    const child = spawn(process.execPath, [path.join(appDir, "server", "dist", "index.js")], {
      cwd: dir,
      detached: true,
      stdio: ["ignore", logHandle.fd, logHandle.fd],
      env,
    });
    await logHandle.close();
    let exited = false;
    let exitCode;
    child.on("exit", (code) => { exited = true; exitCode = code; });
    // If the harness itself dies, the disposable application must not outlive it.
    const forceKill = () => { try { process.kill(-child.pid, "SIGKILL"); } catch { /* already gone */ } };
    process.once("exit", forceKill);
    const baseUrl = `http://${LOOPBACK_HOST}:${port}`;
    const client = createAppClient(baseUrl);

    let stopped = false;
    const stop = async () => {
      process.removeListener("exit", forceKill);
      if (stopped) return;
      stopped = true;
      if (!exited) {
        try { process.kill(-child.pid, "SIGTERM"); } catch { try { child.kill("SIGTERM"); } catch { /* already gone */ } }
        const deadline = Date.now() + 8_000;
        while (!exited && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 100));
      }
      // Whatever is left of the group goes now, even when the leader has already
      // exited: a converter or a probe belongs to the group, not to the leader.
      try { process.kill(-child.pid, "SIGKILL"); } catch { /* no such group */ }
      if (!exited) {
        try { child.kill("SIGKILL"); } catch { /* already gone */ }
        const hard = Date.now() + 3_000;
        while (!exited && Date.now() < hard) await new Promise((resolve) => setTimeout(resolve, 50));
      }
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    };

    const api = async (target, apiOptions = {}) => {
      if (exited) fail("app-exited", `the verification application exited with code ${exitCode}`);
      return client.request(target, apiOptions);
    };

    try {
      await waitFor(async () => {
        if (exited) fail("app-exited", `the verification application exited with code ${exitCode} before it became ready`);
        const response = await client.request("/api/status", { timeoutMs: 3_000 });
        if (response.status !== 200) return undefined;
        const body = response.json();
        return body?.status === "ok" ? body : undefined;
      }, { deadlineMs: options.startupMs ?? 60_000, label: "the verification application" });

      const username = `verify-${randomBytes(4).toString("hex")}`;
      const password = randomBytes(24).toString("base64url");
      const setup = await client.request("/api/auth/setup", { method: "POST", body: { username, password, language: "en" } });
      if (setup.status !== 201) fail("setup", `the disposable application refused first-run setup (${setup.status})`);
      const setCookie = setup.headers.get("set-cookie") ?? "";
      const cookie = setCookie.split(";")[0];
      if (!cookie.includes("=") || cookie.length < 8) fail("setup", "the disposable application set no session cookie");
      const authenticated = createAppClient(baseUrl, cookie);
      const status = await authenticated.request("/api/status");
      const build = status.json();
      return {
        baseUrl,
        port,
        dir,
        dataDir,
        logPath,
        pid: child.pid,
        version: typeof build?.version === "string" ? build.version : undefined,
        strippedInheritedEnv: stripped,
        keyFile,
        libraryRoots,
        request: (target, apiOptions) => {
          const merged = { ...apiOptions, headers: { ...(apiOptions?.headers ?? {}), cookie } };
          return api(target, merged);
        },
        bytes: (target, apiOptions) => {
          if (exited) fail("app-exited", "the verification application exited before the byte request");
          return authenticated.bytes(target, apiOptions);
        },
        stop,
      };
    } catch (error) {
      await stop();
      throw error;
    }
  } catch (error) {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}
