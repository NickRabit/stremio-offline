import type express from "express";
import { build } from "../build.js";
import type { DownloadQueue } from "../downloads.js";
import type { LibraryScan } from "../library-scan.js";
import { clearLog, currentLevel, log, parseLevel, readLog } from "../logger.js";
import { safeSourceText } from "../media-resources.js";
import { metadataOutbound, outbound } from "../outbound.js";
import { sourceTitle, type PlaybackManager } from "../playback.js";
import type { StatsLog, TrafficMeta } from "../stats.js";
import type { Throughput } from "../throughput.js";
import type { StreamItem } from "../types.js";
import { asyncRoute, type RouteContext } from "./context.js";

export interface DiagnosticsDeps extends RouteContext {
  stats: StatsLog;
  playback: PlaybackManager;
  throughput: Throughput;
  queue: DownloadQueue;
  libraryScan: LibraryScan;
  playbackMeta(stream: StreamItem): TrafficMeta;
  freeSpace(target: string): Promise<{ path: string; freeBytes?: number; totalBytes?: number }>;
  dataDir: string;
}

/** The browser is the only place where playback failure is actually visible. Without this
 * channel hls.js and video element errors end up in a console the user never opens. */
const CLIENT_LOG_PER_MINUTE = 30;
/** Enough for a stack frame and a few identifiers; a report is a hint, not a payload. */
const CLIENT_LOG_KEYS = 20;
const clientReports = new Map<string, { count: number; resetAt: number }>();

export function registerDiagnosticsRoutes(app: express.Application, deps: DiagnosticsDeps): void {
  const { store, currentUser, stats, playback, throughput, queue, libraryScan, playbackMeta, freeSpace, dataDir } = deps;

  app.get("/api/stats", (req, res) => res.json(stats.summary(Number(req.query.hours) || 720)));
  /** Playback running at this moment. The statistics otherwise look backwards; this is the
   * one view of what the line is carrying right now. */
  app.get("/api/stats/streams", (_req, res) => res.json(playback.active().map((session) => {
    const meta = playbackMeta(session.stream);
    const { bytes, rate } = throughput.read(session.id);
    return {
      id: session.id,
      title: safeSourceText(sourceTitle(session.stream), session.stream) || meta.title,
      source: meta.source,
      provider: meta.source === "library" ? undefined : meta.provider,
      addonName: safeSourceText(session.stream.addonName, session.stream),
      mode: session.mode, hardware: session.hardware, quality: session.quality,
      duration: session.duration, startedAt: session.startedAt, idleSeconds: session.idleSeconds,
      bytes, rate,
    };
  })));
  app.get("/api/logs", asyncRoute(async (req, res) => {
    const tail = Math.max(0, Math.min(5000, Number(req.query.tail) || 0));
    const hours = Math.max(0, Math.min(24 * 365, Number(req.query.hours) || 0));
    const search = typeof req.query.q === "string" ? req.query.q.trim().slice(0, 100) : "";
    const text = await readLog({ tail: tail || undefined, level: parseLevel(req.query.level), hours: hours || undefined, search: search || undefined });
    res.type("text/plain; charset=utf-8");
    // Viewing in the interface wants text in the window; downloading wants a file.
    if (req.query.inline !== "1") res.setHeader("content-disposition", "attachment; filename=stremio-offline.log");
    res.send(text);
  }));
  app.delete("/api/logs", asyncRoute(async (req, res) => {
    await clearLog();
    log("INFO", "Log cleared from the interface", { user: currentUser(req)?.username });
    res.status(204).end();
  }));
  app.post("/api/client-log", (req, res) => {
    const now = Date.now();
    const who = currentUser(req)?.username ?? req.ip ?? "anonymous";
    const bucket = clientReports.get(who);
    if (!bucket || bucket.resetAt <= now) clientReports.set(who, { count: 1, resetAt: now + 60_000 });
    // A looping player can report an error a hundred times a second; the excess is dropped quietly.
    else if (bucket.count >= CLIENT_LOG_PER_MINUTE) return void res.status(204).end();
    else bucket.count += 1;
    if (clientReports.size > 200) for (const [key, value] of clientReports) if (value.resetAt <= now) clientReports.delete(key);

    const level = parseLevel(req.body?.level) ?? "WARN";
    const message = String(req.body?.message ?? "").slice(0, 200) || "client report";
    // Nested rather than spread. Every signed-in account may post here, and a spread let the
    // caller name any field it liked -- including the ones the server's own audit lines use,
    // such as `actor` and `userId`. Under one key it can still say anything, and nothing it
    // says can be mistaken for something the server recorded.
    const sent = req.body?.context && typeof req.body.context === "object" && !Array.isArray(req.body.context)
      ? req.body.context as Record<string, unknown> : {};
    const context = Object.fromEntries(Object.entries(sent).slice(0, CLIENT_LOG_KEYS));
    log(level, `[web] ${message}`, { client: context, req: req.id, user: currentUser(req)?.username, ua: String(req.headers["user-agent"] ?? "").slice(0, 160) });
    res.status(204).end();
  });

  /** Server state for troubleshooting. It does not belong in /api/status, which needs no sign-in. */
  app.get("/api/diagnostics", asyncRoute(async (_req, res) => {
    const jobs = queue.list();
    const byStatus: Record<string, number> = {};
    for (const job of jobs) byStatus[job.status] = (byStatus[job.status] ?? 0) + 1;
    res.json({
      ...build,
      node: process.version,
      uptimeSeconds: Math.round(process.uptime()),
      memoryMb: Math.round(process.memoryUsage().rss / (1024 * 1024)),
      logLevel: currentLevel(),
      logRetentionDays: Math.max(0, Number(process.env.LOG_RETENTION_DAYS ?? 7) || 0),
      playback: playback.diagnostics(),
      downloads: {
        total: jobs.length, byStatus,
        halt: queue.haltInfo(),
        failed: jobs.filter((job) => job.status === "failed").slice(0, 10).map((job) => ({ id: job.id, title: job.title, error: job.error, errorKey: job.errorKey })),
      },
      addons: store.addons().map((addon) => ({ name: addon.manifest.name, role: addon.role, enabled: addon.enabled })),
      outbound: outbound.diagnostics(),
      metadataOutbound: metadataOutbound.diagnostics(),
      libraryScan: libraryScan.snapshot(),
      storage: [await freeSpace(dataDir), ...await Promise.all(store.libraries().map((library) => freeSpace(library.root)))],
    });
  }));
}
