import type express from "express";
import { build } from "../build.js";
import { CLIENT_LOG_MAX_BYTES, CLIENT_LOG_MAX_LINES, type ClientLogLine, type ClientLogStore } from "../client-logs.js";
import type { DownloadQueue } from "../downloads.js";
import { AppError } from "../errors.js";
import type { LibraryScan } from "../library-scan.js";
import { clearLog, currentLevel, log, parseLevel, readLog } from "../logger.js";
import { safeSourceText } from "../media-resources.js";
import { metadataOutbound, outbound } from "../outbound.js";
import { sourceTitle, type PlaybackManager } from "../playback.js";
import type { ImageStats } from "../image-stats.js";
import type { StatsLog, TrafficMeta } from "../stats.js";
import type { Throughput } from "../throughput.js";
import type { StreamItem } from "../types.js";
import { asyncRoute, type RouteContext } from "./context.js";

export interface DiagnosticsDeps extends RouteContext {
  stats: StatsLog;
  /** Picture counts for the statistics page. Absent in route tests that only stub traffic. */
  imageStats?: ImageStats;
  playback: PlaybackManager;
  throughput: Throughput;
  queue: DownloadQueue;
  libraryScan: LibraryScan;
  playbackMeta(stream: StreamItem): TrafficMeta;
  freeSpace(target: string): Promise<{ path: string; freeBytes?: number; totalBytes?: number }>;
  /** The bundles clients uploaded, one JSON file each under the data directory. */
  clientLogs: ClientLogStore;
  dataDir: string;
}

/** The browser is the only place where playback failure is actually visible. Without this
 * channel hls.js and video element errors end up in a console the user never opens. */
const CLIENT_LOG_PER_MINUTE = 30;
/** Enough for a stack frame and a few identifiers; a report is a hint, not a payload. */
const CLIENT_LOG_KEYS = 20;
/** A bundle is a report someone deliberately sent, not a stream of errors, so the ceiling is
 *  generous per account but low enough that a looping television cannot fill the disk. */
const CLIENT_LOG_BUNDLES_PER_HOUR = 6;
/** A report is one line: control characters become spaces, so a message cannot smuggle a
 *  second line that reads as though the server wrote it. */
const CONTROL = /[\u0000-\u001f\u007f\u0085\u2028\u2029]/g;
const oneLine = (value: string) => value.replace(CONTROL, " ");
const clientReports = new Map<string, { count: number; resetAt: number }>();
const clientBundles = new Map<string, { count: number; resetAt: number }>();

/** The channel that sent a report, defaulting to the browser. */
const clientOf = (value: unknown): "web" | "tv" => value === "tv" ? "tv" : "web";

/** A trimmed, one-line string field of a bundle, or nothing when it is empty. */
const bundleText = (value: unknown, max: number): string | undefined => {
  const text = oneLine(String(value ?? "")).trim().slice(0, max);
  return text || undefined;
};

/** One line of a bundle, dropped rather than refused when it carries nothing usable: a bundle
 *  is a picture of a client's moment and the whole of it is worth more than one bad line. */
const bundleLine = (raw: unknown): ClientLogLine | undefined => {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const item = raw as Record<string, unknown>;
  const message = oneLine(String(item.message ?? "")).slice(0, 2000);
  if (!message) return undefined;
  const context = item.context && typeof item.context === "object" && !Array.isArray(item.context)
    ? Object.fromEntries(Object.entries(item.context as Record<string, unknown>).slice(0, CLIENT_LOG_KEYS)
      .map(([key, value]) => [key, typeof value === "string" ? oneLine(value) : value]))
    : undefined;
  return {
    t: typeof item.t === "string" ? item.t.slice(0, 40) : new Date().toISOString(),
    level: parseLevel(item.level) ?? "INFO",
    message,
    ...(context && Object.keys(context).length ? { context } : {}),
  };
};

export function registerDiagnosticsRoutes(app: express.Application, deps: DiagnosticsDeps): void {
  const { store, currentUser, stats, imageStats, playback, throughput, queue, libraryScan, playbackMeta, freeSpace, clientLogs, dataDir } = deps;

  app.get("/api/stats/activity", (req, res) => {
    res.setHeader("cache-control", "private, no-store");
    res.json(stats.activity.page(Number(req.query.hours) || 720, String(req.query.kind ?? ""), String(req.query.user ?? ""), Number(req.query.before) || undefined));
  });
  app.get("/api/stats", (req, res) => {
    const hours = Number(req.query.hours) || 720;
    const summary = stats.summary(hours);
    res.json(imageStats ? { ...summary, images: imageStats.summary(hours) } : summary);
  });
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
    const message = oneLine(String(req.body?.message ?? "")).slice(0, 200) || "client report";
    // Nested rather than spread. Every signed-in account may post here, and a spread let the
    // caller name any field it liked -- including the ones the server's own audit lines use,
    // such as `actor` and `userId`. Under one key it can still say anything, and nothing it
    // says can be mistaken for something the server recorded.
    const sent = req.body?.context && typeof req.body.context === "object" && !Array.isArray(req.body.context)
      ? req.body.context as Record<string, unknown> : {};
    const context = Object.fromEntries(Object.entries(sent).slice(0, CLIENT_LOG_KEYS)
      .map(([key, value]) => [key, typeof value === "string" ? oneLine(value) : value]));
    // A player report about a running conversion carries the server's view of the same moment:
    // how far ahead of the player the conversion is, and whether the source or FFmpeg holds it back.
    const pace = typeof context.session === "string" ? playback.pace(context.session) : undefined;
    const lead = pace?.position !== undefined && typeof context.position === "number" ? Math.round(pace.position - context.position) : undefined;
    const server = pace ? { ...pace, ...(lead !== undefined ? { lead } : {}) } : undefined;
    log(level, `[${clientOf(req.body?.client)}] ${message}`, { client: context, ...(server ? { server } : {}), req: req.id, user: currentUser(req)?.username, ua: String(req.headers["user-agent"] ?? "").slice(0, 160) });
    res.status(204).end();
  });

  /** A whole session's log from a device that cannot open a console: a television, or a phone
   *  the owner is not sitting at. Any signed-in account may send one; only an administrator may
   *  read the list back. */
  app.post("/api/client-log/bundle", asyncRoute(async (req, res) => {
    const user = currentUser(req);
    const who = user?.username ?? req.ip ?? "anonymous";
    const now = Date.now();
    const bucket = clientBundles.get(who);
    if (!bucket || bucket.resetAt <= now) clientBundles.set(who, { count: 1, resetAt: now + 3_600_000 });
    else if (bucket.count >= CLIENT_LOG_BUNDLES_PER_HOUR) throw new AppError("Too many log bundles. Try again later.", "err.clientLogTooMany", 429);
    else bucket.count += 1;
    if (clientBundles.size > 500) for (const [key, value] of clientBundles) if (value.resetAt <= now) clientBundles.delete(key);

    const raw = req.body && typeof req.body === "object" ? req.body as Record<string, unknown> : {};
    // The body parser already refuses anything larger, but the route states the ceiling itself
    // so a mount with a larger limit cannot let a bundle past.
    if (Buffer.byteLength(JSON.stringify(raw)) > CLIENT_LOG_MAX_BYTES) throw new AppError("The log bundle is too large.", "err.clientLogTooLarge", 413);
    const rawLines = Array.isArray(raw.lines) ? raw.lines : [];
    if (rawLines.length > CLIENT_LOG_MAX_LINES) throw new AppError("The log bundle is too large.", "err.clientLogTooLarge", 400);
    const lines = rawLines.map(bundleLine).filter((line): line is ClientLogLine => line !== undefined);
    const note = bundleText(raw.note, 200);
    const summary = await clientLogs.save({
      user: who, client: clientOf(raw.client),
      app: bundleText(raw.app, 60) ?? "", device: bundleText(raw.device, 120) ?? "",
      ...(note ? { note } : {}), lines,
    });
    log("INFO", "Client log bundle stored", { id: summary.id, user: who, client: summary.client, device: summary.device, lines: summary.lines });
    res.status(201).json({ id: summary.id });
  }));

  app.get("/api/client-logs", asyncRoute(async (_req, res) => {
    // Bundles carry device names, notes and usernames; nothing between here and the screen may cache them.
    res.setHeader("cache-control", "private, no-store");
    res.json(await clientLogs.list());
  }));
  app.get("/api/client-logs/:id", asyncRoute(async (req, res) => {
    const bundle = await clientLogs.get(String(req.params.id));
    if (!bundle) throw new AppError("The log bundle was not found.", "err.itemNotFound", 404);
    res.setHeader("cache-control", "private, no-store");
    res.json(bundle);
  }));
  app.delete("/api/client-logs/:id", asyncRoute(async (req, res) => {
    await clientLogs.remove(String(req.params.id));
    res.status(204).end();
  }));

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
