import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import express from "express";
import { ClientLogStore } from "../client-logs.js";
import type { DownloadQueue } from "../downloads.js";
import { messageKeyOf } from "../errors.js";
import type { LibraryScan } from "../library-scan.js";
import { flushLog, initLogger, readLog, setLevel } from "../logger.js";
import type { PlaybackManager } from "../playback.js";
import type { StatsLog } from "../stats.js";
import type { Store } from "../store.js";
import type { Throughput } from "../throughput.js";
import type { UserRecord } from "../users.js";
import { registerDiagnosticsRoutes, type DiagnosticsDeps } from "./diagnostics.js";

interface Harness {
  base: string;
  hours: number[];
  /** The directory bundles are written under; a test can read it back. */
  dataDir: string;
  close(): Promise<void>;
}

/** The routes take everything they need from the context, so the app here is a real express
 *  instance over fake collaborators that record what they were asked to do. */
const mount = async (jobs: unknown[] = [], options: { user?: UserRecord } = {}): Promise<Harness> => {
  const hours: number[] = [];
  const dataDir = await mkdtemp(path.join(tmpdir(), "routes-client-logs-"));
  const deps: DiagnosticsDeps = {
    store: { addons: () => [], libraries: () => [] } as unknown as Store,
    needsSetup: () => false,
    currentSession: () => undefined,
    currentUser: () => options.user,
    isSecure: () => false,
    stopOwnedPlayback: async () => undefined,
    stopUserSessions: async () => undefined,
    requireAccess: () => undefined,
    stopContentAccess: async () => undefined,
    stats: { summary: (value: number) => { hours.push(value); return { hours: value }; } } as unknown as StatsLog,
    playback: { active: () => [], diagnostics: () => ({ sessions: [] }) } as unknown as PlaybackManager,
    throughput: { read: () => ({ bytes: 0, rate: 0 }) } as unknown as Throughput,
    queue: { list: () => jobs, haltInfo: () => null } as unknown as DownloadQueue,
    libraryScan: { snapshot: () => ({ running: false }) } as unknown as LibraryScan,
    playbackMeta: () => ({ source: "catalog", provider: "example", title: "title", kind: "other" }),
    freeSpace: async (target: string) => ({ path: target, freeBytes: 10, totalBytes: 20 }),
    clientLogs: new ClientLogStore(dataDir),
    dataDir,
  };
  const app = express();
  // A bundle may carry up to 512 KB, more than the ordinary body limit; the parser sits a
  // little above it so the route's own ceiling is what refuses an oversized bundle.
  app.use(express.json({ limit: "1mb" }));
  registerDiagnosticsRoutes(app, deps);
  app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    const status = typeof (error as { status?: unknown }).status === "number" ? (error as { status: number }).status : 400;
    res.status(status).json({ error: error instanceof Error ? error.message : String(error), messageKey: messageKeyOf(error) });
  });
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;
  return {
    base: `http://127.0.0.1:${port}`,
    hours,
    dataDir,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(dataDir, { recursive: true, force: true });
    },
  };
};

const api = (base: string, pathname: string, init: { method?: string; body?: unknown } = {}) =>
  fetch(`${base}${pathname}`, {
    method: init.method ?? "GET",
    headers: init.body === undefined ? {} : { "content-type": "application/json" },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });

test("GET /api/stats passes the hours query through", async (t) => {
  const harness = await mount();
  t.after(harness.close);
  const response = await api(harness.base, "/api/stats?hours=24");
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { hours: 24 });
  assert.deepEqual(harness.hours, [24]);
});

test("GET /api/stats defaults to 720 when hours is absent or unparseable", async (t) => {
  const harness = await mount();
  t.after(harness.close);
  assert.equal((await api(harness.base, "/api/stats")).status, 200);
  assert.equal((await api(harness.base, "/api/stats?hours=weekly")).status, 200);
  assert.deepEqual(harness.hours, [720, 720]);
});

test("GET /api/diagnostics groups the queue by status and caps the failed list at ten", async (t) => {
  const statuses = [...Array.from({ length: 12 }, () => "failed"), "completed", "queued", "completed"];
  const jobs = statuses.map((status, index) => ({ id: `job-${index}`, status, title: `Job ${index}`, error: "boom", errorKey: "err.boom" }));
  const harness = await mount(jobs);
  t.after(harness.close);
  const response = await api(harness.base, "/api/diagnostics");
  assert.equal(response.status, 200);
  const body = await response.json() as { downloads: { total: number; byStatus: Record<string, number>; halt: unknown; failed: Array<{ id: string }> } };
  assert.equal(body.downloads.total, 15);
  assert.deepEqual(body.downloads.byStatus, { failed: 12, completed: 2, queued: 1 });
  assert.equal(body.downloads.halt, null);
  assert.equal(body.downloads.failed.length, 10);
  assert.deepEqual(body.downloads.failed.map((job) => job.id), Array.from({ length: 10 }, (_, index) => `job-${index}`));
});

test("POST /api/client-log records at the level the body asks for", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "routes-diagnostics-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const previousStdout = process.env.LOG_STDOUT;
  process.env.LOG_STDOUT = "0";
  t.after(() => { if (previousStdout === undefined) delete process.env.LOG_STDOUT; else process.env.LOG_STDOUT = previousStdout; });
  await initLogger(dir);
  setLevel("DEBUG");
  const harness = await mount();
  t.after(harness.close);
  const response = await api(harness.base, "/api/client-log", { method: "POST", body: { level: "ERROR", message: "video element failed" } });
  assert.equal(response.status, 204);
  await flushLog();
  const written = await readLog({ level: "ERROR" });
  assert.match(written, / ERROR \[web\] video element failed/);
});

test("POST /api/client-log keeps a forged line out of the log", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "routes-client-log-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const previousStdout = process.env.LOG_STDOUT;
  process.env.LOG_STDOUT = "0";
  t.after(() => { if (previousStdout === undefined) delete process.env.LOG_STDOUT; else process.env.LOG_STDOUT = previousStdout; });
  await initLogger(dir);
  setLevel("DEBUG");
  const harness = await mount();
  t.after(harness.close);
  const forged = "2026-01-01T00:00:00.000Z INFO Account deleted";
  const response = await api(harness.base, "/api/client-log", {
    method: "POST",
    body: { level: "INFO", message: `report\r\n${forged}`, context: { note: `x\n${forged}` } },
  });
  assert.equal(response.status, 204);
  await flushLog();
  const written = await readLog({ level: "INFO" });
  const lines = written.split("\n").filter(Boolean);
  assert.equal(lines.length, 1, `the forged line did not split the log\n${written}`);
  assert.equal(lines[0]!.startsWith(forged), false, "the forged line does not stand as its own record");
  assert.equal(lines[0]!.includes(forged), true, "the text is kept, on the one line");
});

const signedIn = (username: string): UserRecord => ({ id: `usr_${username}`, username, role: "user" } as unknown as UserRecord);
const bundleBody = (over: Record<string, unknown> = {}) => ({
  client: "tv", app: "1.4.0", device: "Living room TV", note: "keeps stalling",
  lines: [{ t: "2026-01-01T00:00:00.000Z", level: "ERROR", message: "Decoder failed", context: { codec: "hevc" } }],
  ...over,
});

test("POST /api/client-log prefixes a television's line with [tv]", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "routes-client-log-tv-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const previousStdout = process.env.LOG_STDOUT;
  process.env.LOG_STDOUT = "0";
  t.after(() => { if (previousStdout === undefined) delete process.env.LOG_STDOUT; else process.env.LOG_STDOUT = previousStdout; });
  await initLogger(dir);
  setLevel("DEBUG");
  const harness = await mount();
  t.after(harness.close);
  const response = await api(harness.base, "/api/client-log", { method: "POST", body: { client: "tv", level: "WARN", message: "buffering" } });
  assert.equal(response.status, 204);
  await flushLog();
  const written = await readLog({ level: "WARN" });
  assert.match(written, / WARN \[tv\] buffering/);
});

test("a bundle round-trips: stored, listed, read back and deleted", async (t) => {
  const harness = await mount([], { user: signedIn("bundle-user") });
  t.after(harness.close);

  const created = await api(harness.base, "/api/client-log/bundle", { method: "POST", body: bundleBody() });
  assert.equal(created.status, 201);
  const { id } = await created.json() as { id: string };
  assert.equal(typeof id, "string");

  const listed = await api(harness.base, "/api/client-logs");
  assert.equal(listed.headers.get("cache-control"), "private, no-store");
  const list = await listed.json() as Array<{ id: string; user: string; client: string; app: string; device: string; note?: string; lines: number }>;
  assert.equal(list.length, 1);
  assert.deepEqual(
    { id: list[0]!.id, user: list[0]!.user, client: list[0]!.client, app: list[0]!.app, device: list[0]!.device, note: list[0]!.note, lines: list[0]!.lines },
    { id, user: "bundle-user", client: "tv", app: "1.4.0", device: "Living room TV", note: "keeps stalling", lines: 1 },
  );

  const read = await api(harness.base, `/api/client-logs/${id}`);
  assert.equal(read.headers.get("cache-control"), "private, no-store");
  const one = await read.json() as { lines: Array<{ message: string; context?: Record<string, unknown> }> };
  assert.equal(one.lines.length, 1);
  assert.equal(one.lines[0]!.message, "Decoder failed");
  assert.deepEqual(one.lines[0]!.context, { codec: "hevc" });

  assert.equal((await api(harness.base, `/api/client-logs/${id}`, { method: "DELETE" })).status, 204);
  assert.equal((await api(harness.base, `/api/client-logs/${id}`)).status, 404);
  assert.deepEqual(await (await api(harness.base, "/api/client-logs")).json(), []);
});

test("POST /api/client-log/bundle refuses more than a thousand lines", async (t) => {
  const harness = await mount([], { user: signedIn("too-many-lines") });
  t.after(harness.close);
  const lines = Array.from({ length: 1001 }, (_, index) => ({ t: "2026-01-01T00:00:00.000Z", level: "INFO", message: `line ${index}` }));
  const response = await api(harness.base, "/api/client-log/bundle", { method: "POST", body: bundleBody({ lines }) });
  assert.equal(response.status, 400);
  assert.equal((await response.json() as { messageKey?: string }).messageKey, "err.clientLogTooLarge");
  assert.deepEqual(await (await api(harness.base, "/api/client-logs")).json(), [], "nothing is stored");
});

test("POST /api/client-log/bundle refuses a body larger than 512 KB", async (t) => {
  const harness = await mount([], { user: signedIn("too-big") });
  t.after(harness.close);
  const lines = [{ t: "2026-01-01T00:00:00.000Z", level: "INFO", message: "x".repeat(600 * 1024) }];
  const response = await api(harness.base, "/api/client-log/bundle", { method: "POST", body: bundleBody({ lines }) });
  assert.equal(response.status, 413);
  assert.equal((await response.json() as { messageKey?: string }).messageKey, "err.clientLogTooLarge");
  assert.deepEqual(await (await api(harness.base, "/api/client-logs")).json(), [], "nothing is stored");
});

test("POST /api/client-log/bundle allows six bundles an hour per account", async (t) => {
  const harness = await mount([], { user: signedIn("rate-limited") });
  t.after(harness.close);
  for (let index = 0; index < 6; index += 1) {
    assert.equal((await api(harness.base, "/api/client-log/bundle", { method: "POST", body: bundleBody() })).status, 201, `bundle ${index}`);
  }
  const refused = await api(harness.base, "/api/client-log/bundle", { method: "POST", body: bundleBody() });
  assert.equal(refused.status, 429);
  assert.equal((await refused.json() as { messageKey?: string }).messageKey, "err.clientLogTooMany");
  assert.equal((await (await api(harness.base, "/api/client-logs")).json() as unknown[]).length, 6, "the seventh is not stored");
});
