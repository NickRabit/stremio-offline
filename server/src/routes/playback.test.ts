import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import express from "express";
import type { AirPlayAccess } from "../airplay-access.js";
import type { SessionInfo } from "../auth.js";
import { flushLog, initLogger, readLog, setLevel } from "../logger.js";
import type { ResourceOwner } from "../media-resources.js";
import type { PlaybackManager } from "../playback.js";
import type { RangeCache } from "../range-cache.js";
import type { StatsLog } from "../stats.js";
import { defaultPrefs, type Store } from "../store.js";
import type { StreamItem } from "../types.js";
import type { UserRecord } from "../users.js";
import { registerPlaybackRoutes, type PlaybackDeps } from "./playback.js";

const ID = "pb_000001";
const RESOURCE = "res_000001";
const TOKEN = "airplay-token";
const ADA: ResourceOwner = { sid: "sid-ada", expiresAt: Date.now() + 3_600_000 };
const BOB: ResourceOwner = { sid: "sid-bob", expiresAt: Date.now() + 3_600_000 };

interface Harness {
  base: string;
  attended: string[];
  stopped: string[];
  close(): Promise<void>;
}

/** The routes take every collaborator from the deps, so the app here is a real express
 *  instance over a playback manager that records what it was asked to do. */
const mount = async (): Promise<Harness> => {
  const attended: string[] = [];
  const stopped: string[] = [];
  const sessions = { ada: ADA, bob: BOB };
  const userOf = (req: express.Request) => (req.header("x-user") === "bob" ? "bob" : "ada");
  const ownerOf = (req: express.Request) => sessions[userOf(req)];

  const deps: PlaybackDeps = {
    store: { addons: () => [], libraries: () => [] } as unknown as Store,
    needsSetup: () => false,
    currentSession: (req) => ({ sid: sessions[userOf(req)].sid, userId: "usr_00000001", expiresAt: sessions[userOf(req)].expiresAt }) as SessionInfo,
    currentUser: (req) => ({ username: userOf(req) }) as unknown as UserRecord,
    isSecure: () => false,
    stopOwnedPlayback: async () => undefined,
    airplayAccess: { create: () => undefined, remove: () => undefined, url: (_id: string, url: string) => url } as unknown as AirPlayAccess,
    airplayRequest: (req) => {
      if (req.query.airplay !== TOKEN) return undefined;
      return { playbackId: ID, owner: ADA, resourceId: RESOURCE, token: TOKEN, expiresAt: Date.now() + 60_000 };
    },
    answerHeaders: () => ({}),
    countBytes: () => undefined,
    httpSourceOf: async () => ({ url: "https://example.test/video.mp4" }) as StreamItem,
    internalMediaRequest: () => false,
    libraryTarget: async (value: string) => value,
    noteSourceQuiet: () => undefined,
    ownerOf,
    playback: {
      attended: (id: string) => { attended.push(id); },
      stop: async (id: string) => { stopped.push(id); },
      directory: () => "/tmp/session-generation",
    } as unknown as PlaybackManager,
    playbackMeta: () => ({ source: "catalog", provider: "example.test", title: "title", kind: "other" }),
    playbackOwners: new Map([[ID, { owner: ADA, resourceId: RESOURCE }]]),
    playbackResponse: (value) => value,
    prefsOf: () => defaultPrefs(),
    quietSources: new Map(),
    rangeCache: {} as unknown as RangeCache,
    safeInspection: () => ({ duration: undefined, video: undefined, audioTracks: [], subtitleTracks: [] }),
    sleep: async () => undefined,
    sourceIsQuiet: () => false,
    stats: { complete: () => undefined } as unknown as StatsLog,
    subtitleDelay: () => 0,
    trackMedia: () => undefined,
    SOURCE_ATTEMPTS: 3,
    SOURCE_RETRY_MS: 400,
    SOURCE_RESUMES: 5,
    SOURCE_HEADER_MS: 30_000,
    SOURCE_QUIET_HEADER_MS: 6_000,
  };

  const app = express();
  app.use(express.json());
  registerPlaybackRoutes(app, deps);
  app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    const status = typeof (error as { status?: unknown }).status === "number" ? (error as { status: number }).status : 400;
    res.status(status).json({ error: error instanceof Error ? error.message : String(error) });
  });
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;
  return {
    base: `http://127.0.0.1:${port}`,
    attended,
    stopped,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
};

const api = (base: string, pathname: string, init: { method?: string; body?: unknown; user?: "ada" | "bob" } = {}) =>
  fetch(`${base}${pathname}`, {
    method: init.method ?? "GET",
    headers: {
      ...(init.user ? { "x-user": init.user } : {}),
      ...(init.body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });

/** `fetch` resolves a dot segment before it leaves, so a path the handler must judge goes on
 *  the wire as it stands. */
const rawGet = (base: string, pathname: string, user: "ada" | "bob") =>
  new Promise<{ status: number; body: string }>((resolve, reject) => {
    const url = new URL(base);
    const request = http.request({ host: url.hostname, port: url.port, path: pathname, method: "GET", headers: { "x-user": user } }, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk: string) => { body += chunk; });
      response.on("end", () => resolve({ status: response.statusCode ?? 0, body }));
    });
    request.on("error", reject);
    request.end();
  });

test("the ownership guard answers somebody else's session with a bare 404", async (t) => {
  const harness = await mount();
  t.after(harness.close);

  const response = await api(harness.base, `/api/playback/${ID}/ping`, { method: "POST", user: "bob" });

  assert.equal(response.status, 404, "404, so the answer does not confirm the session exists");
  assert.deepEqual(await response.json(), { error: "Playback session unavailable.", code: "RESOURCE_NOT_FOUND" });
  assert.deepEqual(harness.attended, [], "a refused request never keeps the session alive");
});

test("the guard lets the owner through, makes the frame uncacheable and marks the session attended", async (t) => {
  const harness = await mount();
  t.after(harness.close);

  const response = await api(harness.base, `/api/playback/${ID}/ping`, { method: "POST", user: "ada" });

  assert.equal(response.status, 204);
  assert.equal(response.headers.get("cache-control"), "private, no-store", "one viewer's frames are never cached for another");
  assert.deepEqual(harness.attended, [ID], "attended() is what stops a live session being reaped");
});

test("an AirPlay grant for the session passes the guard where another person's plain session does not", async (t) => {
  const harness = await mount();
  t.after(harness.close);

  const granted = await api(harness.base, `/api/playback/${ID}/ping?airplay=${TOKEN}`, { method: "POST", user: "bob" });
  assert.equal(granted.status, 204);
  assert.equal(granted.headers.get("cache-control"), "private, no-store");

  const plain = await api(harness.base, `/api/playback/${ID}/ping`, { method: "POST", user: "bob" });
  assert.equal(plain.status, 404);
});

test("DELETE /api/playback/:id stops the session and logs who closed it", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "routes-playback-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const previousStdout = process.env.LOG_STDOUT;
  process.env.LOG_STDOUT = "0";
  t.after(() => { if (previousStdout === undefined) delete process.env.LOG_STDOUT; else process.env.LOG_STDOUT = previousStdout; });
  await initLogger(dir);
  setLevel("INFO");
  const harness = await mount();
  t.after(harness.close);

  const response = await api(harness.base, `/api/playback/${ID}`, { method: "DELETE", user: "ada" });

  assert.equal(response.status, 204);
  assert.deepEqual(harness.stopped, [ID]);
  await flushLog();
  const written = await readLog({ level: "INFO" });
  assert.match(written, /Playback session closed by the player/);
  assert.match(written, /"user":"ada"/);
});

test("GET /api/playback/:id/:generation/:file refuses a filename with a slash or a dot segment", async (t) => {
  const harness = await mount();
  t.after(harness.close);

  const dotSegment = await rawGet(harness.base, `/api/playback/${ID}/gen/%2E%2E`, "ada");
  assert.equal(dotSegment.status, 400);
  assert.equal(dotSegment.body, "");

  const slash = await rawGet(harness.base, `/api/playback/${ID}/gen/a%2Fb.m3u8`, "ada");
  assert.equal(slash.status, 400);
});
