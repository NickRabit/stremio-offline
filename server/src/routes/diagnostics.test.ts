import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import express from "express";
import type { DownloadQueue } from "../downloads.js";
import { messageKeyOf } from "../errors.js";
import type { LibraryScan } from "../library-scan.js";
import { flushLog, initLogger, readLog, setLevel } from "../logger.js";
import type { PlaybackManager } from "../playback.js";
import type { StatsLog } from "../stats.js";
import type { Store } from "../store.js";
import type { Throughput } from "../throughput.js";
import { registerDiagnosticsRoutes, type DiagnosticsDeps } from "./diagnostics.js";

interface Harness {
  base: string;
  hours: number[];
  close(): Promise<void>;
}

/** The routes take everything they need from the context, so the app here is a real express
 *  instance over fake collaborators that record what they were asked to do. */
const mount = async (jobs: unknown[] = []): Promise<Harness> => {
  const hours: number[] = [];
  const deps: DiagnosticsDeps = {
    store: { addons: () => [], libraries: () => [] } as unknown as Store,
    needsSetup: () => false,
    currentSession: () => undefined,
    currentUser: () => undefined,
    isSecure: () => false,
    stopOwnedPlayback: async () => undefined,
    stats: { summary: (value: number) => { hours.push(value); return { hours: value }; } } as unknown as StatsLog,
    playback: { active: () => [], diagnostics: () => ({ sessions: [] }) } as unknown as PlaybackManager,
    throughput: { read: () => ({ bytes: 0, rate: 0 }) } as unknown as Throughput,
    queue: { list: () => jobs, haltInfo: () => null } as unknown as DownloadQueue,
    libraryScan: { snapshot: () => ({ running: false }) } as unknown as LibraryScan,
    playbackMeta: () => ({ source: "catalog", provider: "example", title: "title", kind: "other" }),
    freeSpace: async (target: string) => ({ path: target, freeBytes: 10, totalBytes: 20 }),
    dataDir: "/data",
  };
  const app = express();
  app.use(express.json());
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
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
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
