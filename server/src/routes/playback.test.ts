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
import { mediaResources as registry, MediaResources, ResourceError, type ResourceOwner } from "../media-resources.js";
import type { MediaServerManager } from "../media-server-manager.js";
import { MediaServerPlaybackGuard } from "../media-server-playback.js";
import { sealRemoteContent } from "../media-server-reference.js";
import { MediaServerSources } from "../media-server-sources.js";
import { MediaServerError } from "../media-server-types.js";
import type { PlaybackManager } from "../playback.js";
import type { RangeCache } from "../range-cache.js";
import { RemoteReadAhead } from "../remote-read-ahead.js";
import type { StatsLog } from "../stats.js";
import { defaultPrefs, type Store } from "../store.js";
import type { StreamItem } from "../types.js";
import type { UserRecord } from "../users.js";
import { registerPlaybackRoutes, type PlaybackDeps } from "./playback.js";

const ID = "pb_000001";
const TOKEN = "airplay-token";
const ADA: ResourceOwner = { userId: "usr_00000001", sid: "sid-ada", expiresAt: Date.now() + 3_600_000 };
const BOB: ResourceOwner = { userId: "usr_00000002", sid: "sid-bob", expiresAt: Date.now() + 3_600_000 };
// The guard is fail-closed, so the fake session owns a real media resource in the registry.
const RESOURCE = registry.mediaStream({ url: "https://example.test/video.mp4" } as StreamItem, ADA).resourceId;
const sealedRemote = (): string => sealRemoteContent({
  provider: "jellyfin", serverId: "server-1", accountId: "account-1", itemId: "item-1",
  connectionId: `mconn_${"a".repeat(32)}`, libraryId: `rlib_${"b".repeat(32)}`, generation: 2, mediaSourceId: "v1",
  owner: { userId: ADA.userId, sid: ADA.sid, expiresAt: ADA.expiresAt, secretStamp: "c".repeat(64) },
});

interface Harness {
  base: string;
  attended: string[];
  errors: unknown[];
  stopped: string[];
  mediaSources: MediaServerSources;
  playbackOwners: Map<string, { owner: ResourceOwner; resourceId: string }>;
  /** The manager the routes call; a test can replace one method to hold a preparation open. */
  playback: Record<string, any>;
  useSource(stream: StreamItem): void;
  seedRemote(): string;
  close(): Promise<void>;
}

/** The routes take every collaborator from the deps, so the app here is a real express
 *  instance over a playback manager that records what it was asked to do. */
const mount = async (): Promise<Harness> => {
  const attended: string[] = [];
  const errors: unknown[] = [];
  const stopped: string[] = [];
  let source = { url: "https://example.test/video.mp4" } as StreamItem;
  const sessions = { ada: ADA, bob: BOB };
  const userOf = (req: express.Request) => (req.header("x-user") === "bob" ? "bob" : "ada");
  const ownerOf = (req: express.Request) => sessions[userOf(req)];
  const playbackOwners = new Map([[ID, { owner: ADA, resourceId: RESOURCE }]]);
  const resources = new MediaResources();
  const mediaSources = new MediaServerSources(
    { users: () => [], mediaConnections: () => [], remoteLibraries: () => [] } as unknown as Store,
    {} as unknown as MediaServerManager,
    resources,
  );
  const mediaServerGuard = new MediaServerPlaybackGuard({
    sources: mediaSources, resources, playbackOwners, activeMedia: new Set(),
    revocations: { stopResource: async () => undefined },
  }, { intervalMs: 30_000, timeoutMs: 5_000 });

  const playback: Record<string, any> = {
    attended: (id: string) => { attended.push(id); },
    stop: async (id: string) => { stopped.push(id); },
    directory: () => "/tmp/session-generation",
    preview: async () => undefined,
    sidecar: async () => undefined,
    seek: async () => ({ id: ID, url: "u" }),
    escalate: async () => ({ id: ID, url: "u" }),
    track: async () => ({ id: ID, url: "u" }),
    inspect: async () => undefined,
    start: async () => ({ id: "pb_started", url: "/api/playback/pb_started/0/master.m3u8" }),
  };

  const deps: PlaybackDeps = {
    store: { addons: () => [], libraries: () => [] } as unknown as Store,
    needsSetup: () => false,
    currentSession: (req) => ({ sid: sessions[userOf(req)].sid, userId: "usr_00000001", expiresAt: sessions[userOf(req)].expiresAt }) as SessionInfo,
    currentUser: (req) => ({ username: userOf(req) }) as unknown as UserRecord,
    isSecure: () => false,
    stopOwnedPlayback: async () => undefined,
    stopUserSessions: async () => undefined,
    requireAccess: () => undefined,
    stopContentAccess: async () => undefined,
    airplayAccess: { create: () => undefined, remove: () => undefined, url: (_id: string, url: string) => url } as unknown as AirPlayAccess,
    airplayRequest: (req) => {
      if (req.query.airplay !== TOKEN) return undefined;
      return { playbackId: ID, owner: ADA, resourceId: RESOURCE, token: TOKEN, expiresAt: Date.now() + 60_000 };
    },
    answerHeaders: () => ({}),
    countBytes: () => undefined,
    httpSourceOf: async () => source,
    internalMediaRequest: () => false,
    libraryTarget: async (value: string) => value,
    noteSourceQuiet: () => undefined,
    ownerOf,
    playback: playback as unknown as PlaybackManager,
    mediaSources,
    mediaServerGuard,
    playbackMeta: () => ({ source: "catalog", provider: "example.test", title: "title", kind: "other" }),
    playbackOwners,
    playbackResponse: (value) => value,
    prefsOf: () => defaultPrefs(),
    quietSources: new Map(),
    rangeCache: {} as unknown as RangeCache,
    remoteReadAhead: new RemoteReadAhead(),
    safeInspection: () => ({ duration: undefined, video: undefined, audioTracks: [], subtitleTracks: [] }),
    sleep: async () => undefined,
    sourceIsQuiet: () => false,
    stats: { complete: () => undefined, activity: { record: () => undefined } } as unknown as StatsLog,
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
    errors.push(error);
    const status = typeof (error as { status?: unknown }).status === "number" ? (error as { status: number }).status : 400;
    res.status(status).json({ error: error instanceof Error ? error.message : String(error) });
  });
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;
  return {
    base: `http://127.0.0.1:${port}`,
    attended,
    errors,
    stopped,
    mediaSources,
    playbackOwners,
    playback,
    useSource: (stream: StreamItem) => { source = stream; },
    seedRemote: () => registry.mediaStream({ url: sealedRemote() } as StreamItem, ADA).resourceId,
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
  assert.deepEqual(await response.json(), { error: "The playback session no longer exists.", messageKey: "err.playbackSessionGone", code: "RESOURCE_NOT_FOUND" });
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

test("a session whose media resource was removed is refused and stopped, while a sibling continues", async (t) => {
  const harness = await mount();
  t.after(harness.close);
  const doomed = harness.seedRemote();
  harness.playbackOwners.set("pb_doomed", { owner: ADA, resourceId: doomed });
  const alive = registry.mediaStream({ url: "https://example.test/sibling.mp4" } as StreamItem, ADA).resourceId;
  harness.playbackOwners.set("pb_alive", { owner: ADA, resourceId: alive });
  // The resource is revoked while the playback owner survives: the fail-closed guard must deny.
  registry.remove(doomed);

  const denied = await api(harness.base, "/api/playback/pb_doomed/preview", { user: "ada" });
  assert.equal(denied.status, 404);
  assert.ok(harness.stopped.includes("pb_doomed"), "the leaked session is stopped");

  const ok = await api(harness.base, "/api/playback/pb_alive/preview", { user: "ada" });
  assert.equal(ok.status, 204, "the unrelated session is untouched");
});

test("the remote media proxy forwards HEAD and range and binds the resource owner", async (t) => {
  const harness = await mount();
  t.after(harness.close);
  const openCalls: Array<{ method: string; range?: string; owner: ResourceOwner }> = [];
  const sources = harness.mediaSources as unknown as {
    open(stream: StreamItem, owner: ResourceOwner, args: { method: string; range?: string }, signal?: AbortSignal): Promise<Response>;
    assertCurrent(): void;
  };
  sources.assertCurrent = () => undefined;
  sources.open = async (_stream, owner, args) => {
    openCalls.push({ method: args.method, range: args.range, owner });
    if (args.method === "HEAD") return new Response(null, { status: 206, headers: { "content-range": "bytes 0-9/10" } });
    return new Response(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]), { status: 206, headers: { "content-range": "bytes 0-9/10", "content-type": "video/mp4" } });
  };
  const resourceId = harness.seedRemote();

  const head = await api(harness.base, `/api/media/${resourceId}`, { method: "HEAD", user: "ada" });
  assert.equal(head.status, 206);
  assert.equal(head.headers.get("cache-control"), "private, no-store");
  assert.equal(openCalls.at(-1)!.method, "HEAD");

  const ranged = await fetch(`${harness.base}/api/media/${resourceId}`, { headers: { "x-user": "ada", range: "bytes=0-2" } });
  assert.equal(ranged.status, 206);
  assert.deepEqual([...new Uint8Array(await ranged.arrayBuffer())], [1, 2, 3]);
  assert.equal(ranged.headers.get("content-range"), "bytes 0-2/10");
  assert.equal(openCalls.at(-1)!.range, "bytes=0-1048575", "the range reaches the scoped transport as one bounded block");
  assert.equal(openCalls.at(-1)!.owner.userId, ADA.userId, "the owner is the resource's, not the caller's");

  const denied = await api(harness.base, `/api/media/${resourceId}`, { user: "bob" });
  assert.equal(denied.status, 404, "the wrong session cannot read another owner's resource");
});

/** A media-server original that answers ranges the way Jellyfin does, counting every open. */
const rangedOriginal = (harness: Harness, size: number) => {
  const file = Buffer.alloc(size);
  for (let index = 0; index < size; index += 1) file[index] = (index * 31 + (index >> 8)) & 0xff;
  const opens: string[] = [];
  const sources = harness.mediaSources as unknown as {
    open(stream: StreamItem, owner: ResourceOwner, args: { method: string; range?: string }, signal?: AbortSignal): Promise<Response>;
    assertCurrent(): void;
  };
  sources.assertCurrent = () => undefined;
  sources.open = async (_stream, _owner, args) => {
    opens.push(args.range ?? "");
    const match = /^bytes=(\d+)-(\d*)$/.exec(args.range ?? "")!;
    const start = Number(match[1]);
    const end = Math.min(match[2] ? Number(match[2]) : size - 1, size - 1);
    return new Response(file.subarray(start, end + 1), { status: 206, headers: { "content-range": `bytes ${start}-${end}/${size}`, "content-type": "video/x-msvideo" } });
  };
  return { file, opens, sources };
};

/** What FFmpeg does on every jump: asks from an offset to the end, reads a little, hangs up. */
const readSome = async (base: string, resourceId: string, from: number, bytes: number): Promise<Buffer> => {
  const controller = new AbortController();
  const response = await fetch(`${base}/api/media/${resourceId}`, { headers: { "x-user": "ada", range: `bytes=${from}-` }, signal: controller.signal });
  assert.equal(response.status, 206);
  const reader = response.body!.getReader();
  const parts: Buffer[] = [];
  let got = 0;
  while (got < bytes) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(Buffer.from(value));
    got += value.length;
  }
  controller.abort();
  await reader.cancel().catch(() => undefined);
  return Buffer.concat(parts).subarray(0, bytes);
};

test("an OpenDML probe jumping between the super index and the index chunks costs a few media-server reads, not one per jump", async (t) => {
  const harness = await mount();
  t.after(harness.close);
  const size = 6 * 1024 * 1024;
  const { file, opens } = rangedOriginal(harness, size);
  const resourceId = harness.seedRemote();
  const indexAt = size - 3 * 1024 * 1024;

  assert.deepEqual(await readSome(harness.base, resourceId, 0, 4096), file.subarray(0, 4096));
  for (let entry = 0; entry < 40; entry += 1) {
    const header = 260 + entry * 16;
    assert.deepEqual(await readSome(harness.base, resourceId, header, 16), file.subarray(header, header + 16));
    const chunk = indexAt + entry * 65_536;
    assert.deepEqual(await readSome(harness.base, resourceId, chunk, 32_768), file.subarray(chunk, chunk + 32_768));
  }

  assert.ok(opens.length <= 5, `80 jumps asked the media server ${opens.length} times: ${opens.join(", ")}`);
  // A conversion opening the same film again reads what the probe already holds.
  const before = opens.length;
  assert.deepEqual(await readSome(harness.base, resourceId, 0, 4096), file.subarray(0, 4096));
  assert.equal(opens.length, before);
});

test("a read longer than the blocks continues as one ordinary transfer and returns every byte", async (t) => {
  const harness = await mount();
  t.after(harness.close);
  const size = 5 * 1024 * 1024 + 123;
  const { file, opens } = rangedOriginal(harness, size);
  const resourceId = harness.seedRemote();

  const response = await fetch(`${harness.base}/api/media/${resourceId}`, { headers: { "x-user": "ada", range: "bytes=1000-" } });
  assert.equal(response.status, 206);
  assert.equal(response.headers.get("content-range"), `bytes 1000-${size - 1}/${size}`);
  assert.equal(response.headers.get("content-length"), String(size - 1000));
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), file.subarray(1000));
  assert.deepEqual(opens, ["bytes=1000-1049575", "bytes=1049576-2098151", "bytes=2098152-"]);
});

test("a held block is still refused to an owner whose access was withdrawn", async (t) => {
  const harness = await mount();
  t.after(harness.close);
  const { opens, sources } = rangedOriginal(harness, 2 * 1024 * 1024);
  const resourceId = harness.seedRemote();
  await readSome(harness.base, resourceId, 0, 100);
  sources.assertCurrent = () => { throw new ResourceError(404, "RESOURCE_NOT_FOUND"); };

  const denied = await fetch(`${harness.base}/api/media/${resourceId}`, { headers: { "x-user": "ada", range: "bytes=200-" } });
  assert.equal(denied.status, 404);
  assert.equal(opens.length, 1);
});

test("the remote media proxy maps a media-server failure to its fixed sentence", async (t) => {
  const harness = await mount();
  t.after(harness.close);
  const resourceId = harness.seedRemote();
  const sources = harness.mediaSources as unknown as { open(): Promise<Response> };
  sources.open = async () => { throw new MediaServerError("busy", "SENTINEL-INTERNAL-DETAIL", undefined, 5_000); };

  const response = await api(harness.base, `/api/media/${resourceId}`, { user: "ada" });

  assert.equal(response.status, 429, "the mapped status, not the unmodified catch's 502");
  const body = await response.json() as { error: string };
  assert.equal(body.error, "The media server is busy. Try again shortly.");
  assert.ok(!JSON.stringify(body).includes("SENTINEL-INTERNAL-DETAIL"), "the internal message never reaches the body");
});

test("the remote media proxy leaves a stale-owner resource error as a 404", async (t) => {
  const harness = await mount();
  t.after(harness.close);
  const resourceId = harness.seedRemote();
  const sources = harness.mediaSources as unknown as { open(): Promise<Response> };
  sources.open = async () => { throw new ResourceError(404, "RESOURCE_NOT_FOUND"); };

  const response = await api(harness.base, `/api/media/${resourceId}`, { user: "ada" });

  assert.equal(response.status, 404);
  const body = await response.json() as { error: string };
  assert.equal(body.error, "Media resource expired or unavailable. Select the source again.");
  assert.notEqual(body.error, "The media server is unavailable.");
});

test("the remote media proxy returns quietly when the player is already gone", async (t) => {
  const harness = await mount();
  t.after(harness.close);
  const resourceId = harness.seedRemote();
  const sources = harness.mediaSources as unknown as {
    open(stream: StreamItem, owner: ResourceOwner, args: { method: string; range?: string }, signal?: AbortSignal): Promise<Response>;
    assertCurrent(): void;
  };
  sources.assertCurrent = () => undefined;
  let reached!: () => void;
  const waiting = new Promise<void>((resolve) => { reached = resolve; });
  sources.open = (_stream, _owner, _args, signal) => {
    reached();
    return new Promise<Response>((_resolve, reject) => {
      signal?.addEventListener("abort", () => reject(new MediaServerError("cancelled", "The media-server request was cancelled.")), { once: true });
    });
  };

  const controller = new AbortController();
  const pending = fetch(`${harness.base}/api/media/${resourceId}`, { headers: { "x-user": "ada" }, signal: controller.signal }).catch(() => undefined);
  await waiting;
  controller.abort();
  await pending;

  sources.open = async () => new Response(new Uint8Array([1, 2, 3]), { status: 206, headers: { "content-range": "bytes 0-2/5", "content-type": "video/mp4" } });
  const after = await api(harness.base, `/api/media/${harness.seedRemote()}`, { user: "ada" });
  assert.equal(after.status, 206, "the route returned instead of throwing into the error middleware");
  await after.arrayBuffer();
});

/** Waits for a state the server reaches after the client itself has already gone. */
const waitFor = async (predicate: () => boolean) => {
  for (let attempt = 0; attempt < 400 && !predicate(); attempt += 1) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.ok(predicate(), "the expected server state never arrived");
};

/** Records what the route mints and releases without changing the registry's own behaviour. */
const watchResources = (t: { after(fn: () => unknown): unknown }) => {
  const minted: Array<{ stream: StreamItem; resourceId: string }> = [];
  const removed: string[] = [];
  const originalMediaStream = registry.mediaStream.bind(registry);
  const originalRemove = registry.remove.bind(registry);
  registry.mediaStream = (stream: StreamItem, owner: ResourceOwner) => {
    const prepared = originalMediaStream(stream, owner);
    minted.push(prepared);
    return prepared;
  };
  registry.remove = (id: string) => { removed.push(id); return originalRemove(id); };
  t.after(() => { registry.mediaStream = originalMediaStream; registry.remove = originalRemove; });
  return { minted, removed };
};

test("a canceled inspect hands its signal to the manager and releases the prepared resource", async (t) => {
  const harness = await mount();
  t.after(harness.close);
  const { minted, removed } = watchResources(t);
  harness.useSource({ url: sealedRemote() } as StreamItem);
  const sources = harness.mediaSources as unknown as { assertCurrent(): void; authorize(): Promise<void> };
  sources.assertCurrent = () => undefined;
  sources.authorize = async () => undefined;
  let seen: AbortSignal | undefined;
  let answer!: () => void;
  harness.playback.inspect = (_stream: StreamItem, signal?: AbortSignal) => {
    seen = signal;
    return new Promise((resolve) => { answer = () => resolve(undefined); });
  };

  const controller = new AbortController();
  const request = fetch(`${harness.base}/api/inspect`, {
    method: "POST", headers: { "content-type": "application/json", "x-user": "ada" }, body: "{}", signal: controller.signal,
  }).catch(() => undefined);
  await waitFor(() => seen !== undefined);
  controller.abort();
  await request;
  await waitFor(() => seen?.aborted === true);
  answer();
  await waitFor(() => removed.length === 1);

  assert.ok(seen?.aborted, "the manager was handed the request's own signal");
  assert.equal(minted.length, 1, "the request minted one private resource");
  assert.deepEqual(removed, [minted[0].resourceId], "and released exactly that one");
  assert.equal(harness.errors.length, 0, "ordinary client cancellation does not enter error logging");
});

test("a canceled playback request stops a descriptor that raced the disconnect", async (t) => {
  const harness = await mount();
  t.after(harness.close);
  const { minted, removed } = watchResources(t);
  harness.useSource({ url: sealedRemote() } as StreamItem);
  const sources = harness.mediaSources as unknown as { assertCurrent(): void; authorize(): Promise<void> };
  sources.assertCurrent = () => undefined;
  sources.authorize = async () => undefined;
  let seen: AbortSignal | undefined;
  let answer!: () => void;
  harness.playback.start = (_stream: StreamItem, _caps: unknown, _options: unknown, signal?: AbortSignal) => {
    seen = signal;
    return new Promise((resolve) => { answer = () => resolve({ id: "pb_raced", url: "/api/playback/pb_raced/0/master.m3u8" }); });
  };

  const controller = new AbortController();
  const request = fetch(`${harness.base}/api/playback`, {
    method: "POST", headers: { "content-type": "application/json", "x-user": "ada" }, body: "{}", signal: controller.signal,
  }).catch(() => undefined);
  await waitFor(() => seen !== undefined);
  controller.abort();
  await request;
  await waitFor(() => seen?.aborted === true);
  answer();
  await waitFor(() => harness.stopped.length === 1);

  assert.ok(seen?.aborted, "the manager was handed the request's own signal");
  assert.deepEqual(harness.stopped, ["pb_raced"], "the raced session was stopped, never registered");
  assert.equal(harness.playbackOwners.has("pb_raced"), false, "the response closed before registration");
  assert.deepEqual(removed, [minted[0].resourceId], "the prepared resource was released");
  assert.equal(harness.errors.length, 0, "ordinary client cancellation does not enter error logging");
});
