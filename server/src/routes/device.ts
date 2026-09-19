import type express from "express";
import { randomBytes } from "node:crypto";
import { stat } from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { isPlaylist } from "../downloads.js";
import { AppError } from "../errors.js";
import { posixBase, type Viewer } from "../libraries.js";
import { log } from "../logger.js";
import { ResourceError, type DeviceDownloadTicket, type ResourceOwner } from "../media-resources.js";
import { defaultDownloadSettings, deviceFilename, type MediaInfo } from "../naming.js";
import { safeFetch, validateRemoteUrl } from "../security.js";
import type { TrafficMeta } from "../stats.js";
import type { StreamItem } from "../types.js";
import { asyncRoute, type RouteContext } from "./context.js";

/** Saving a stream on the device that asked for it, without handing out the source address. */
export interface DeviceDeps extends RouteContext {
  countBytes(res: express.Response, meta: TrafficMeta, session?: string): void;
  deviceDownloadTickets: Map<string, {
    owner: ResourceOwner;
    expiresAt: number;
    filename: string;
    source: { kind: "local"; path: string } | { kind: "remote"; stream: StreamItem; title: string; media?: MediaInfo };
  }>;
  DEVICE_TICKET_TTL: number;
  httpSourceOf(req: express.Request): Promise<StreamItem>;
  libraryTarget(value: string, viewer: Viewer | undefined): Promise<string>;
  mediaSource(value: unknown): MediaInfo | undefined;
  ownerOf(req: express.Request): ResourceOwner;
  pruneDeviceDownloadTickets(): void;
  statMeta(job: { source?: TrafficMeta["source"]; url?: string; addonKey?: string; addonName?: string; title: string; kind?: string }): TrafficMeta;
  trackMedia(owner: ResourceOwner, res: express.Response, resourceId?: string): void;
}

export function registerDeviceRoutes(app: express.Application, deps: DeviceDeps): void {
  const { store, currentUser, countBytes, deviceDownloadTickets, DEVICE_TICKET_TTL, httpSourceOf, libraryTarget, mediaSource, ownerOf, pruneDeviceDownloadTickets, statMeta, trackMedia } = deps;

  /** Keep the external address out of the download link by exchanging it for a short-lived ticket. */
  app.post("/api/device-download", asyncRoute(async (req, res) => {
    pruneDeviceDownloadTickets();
    let ticket: DeviceDownloadTicket;
    const owner = ownerOf(req);
    const stream = await httpSourceOf(req);
    if (stream.url?.startsWith("file://")) {
      const relative = stream.url.slice(7);
      const target = relative ? await libraryTarget(relative, currentUser(req)).catch(() => undefined) : undefined;
      const info = target ? await stat(target).catch(() => undefined) : undefined;
      if (!target || !info?.isFile()) throw new ResourceError(404, "RESOURCE_NOT_FOUND");
      ticket = {
        owner, expiresAt: Math.min(owner.expiresAt, Date.now() + DEVICE_TICKET_TTL),
        filename: posixBase(relative),
        source: { kind: "local", path: relative },
      };
    } else {
      if (!stream?.url || stream.url.startsWith("file://")) throw new AppError("Only a direct HTTP stream can be saved to a device.", "err.deviceNeedsHttp");
      await validateRemoteUrl(stream.url);
      const title = String(req.body.title ?? "video");
      const media = mediaSource(req.body.media);
      const addon = store.addons().find((item) => item.key === stream.addonKey);
      const settings = addon?.downloadSettings ?? defaultDownloadSettings();
      const targetSettings = media?.kind === "episode" ? settings.series : settings.movie;
      ticket = {
        owner, expiresAt: Math.min(owner.expiresAt, Date.now() + DEVICE_TICKET_TTL),
        filename: deviceFilename(stream, media, title, targetSettings),
        source: { kind: "remote", stream, title, media },
      };
    }
    const id = randomBytes(24).toString("base64url");
    deviceDownloadTickets.set(id, ticket);
    res.status(201).json({ url: `/api/device-download/${id}`, filename: ticket.filename });
  }));

  app.get("/api/device-download/:id", asyncRoute(async (req, res) => {
    pruneDeviceDownloadTickets();
    const ticket = deviceDownloadTickets.get(String(req.params.id));
    if (!ticket || ticket.owner.sid !== ownerOf(req).sid) return res.status(404).json({ error: "The download link expired. Start the download again.", messageKey: "err.downloadTicketExpired" });

    res.setHeader("cache-control", "private, no-store");
    trackMedia(ticket.owner, res);
    if (ticket.source.kind === "local") {
      const target = await libraryTarget(ticket.source.path, currentUser(req));
      if (!target) return res.status(404).json({ error: "The file was not found in the library.", messageKey: "err.libraryFileMissing" });
      countBytes(res, { source: "library", provider: "knihovna", title: ticket.filename, kind: "other" });
      return void res.download(path.basename(target), ticket.filename, { root: path.dirname(target), acceptRanges: true, dotfiles: "deny" }, (error) => {
        if (error && !res.headersSent) res.status(404).json({ error: "The file was not found in the library.", messageKey: "err.libraryFileMissing" });
      });
    }

    const { stream, title, media } = ticket.source;
    // The client only requests the ticket URL; the server handles debrid headers and ranges from its own IP.
    const headers: Record<string, string> = { ...(stream.behaviorHints?.proxyHeaders?.request ?? {}) };
    if (req.headers.range) headers.range = req.headers.range;

    // A playlist is not the media, it is a list of it. Passed on as-is the browser saves a few
    // hundred bytes of text named like a film -- which is what an HLS addon's download did. The
    // queue already assembles these with FFmpeg; so does this, except that the output goes
    // straight down the response, which cannot be seeked back into. That rules out the index at
    // the front (+faststart) and calls for a fragmented file instead.
    if (isPlaylist(stream.url!)) {
      const { spawn } = await import("node:child_process");
      const { playlistArgs } = await import("../probe.js");
      const headerLines = Object.entries(headers)
        .filter(([name]) => name.toLowerCase() !== "range")
        .map(([name, value]) => `${name}: ${value}\r\n`)
        .join("");

      const child = spawn("ffmpeg", [
        "-hide_banner", "-loglevel", "error", "-nostdin",
        "-protocol_whitelist", "file,http,https,tcp,tls,crypto",
        ...(await playlistArgs("ffmpeg")),
        ...(headerLines ? ["-headers", headerLines] : []),
        "-i", stream.url!,
        "-c", "copy",
        // ADTS frames out of a transport stream need this to be legal inside MP4.
        "-bsf:a", "aac_adtstoasc",
        "-movflags", "frag_keyframe+empty_moov+default_base_moof",
        "-f", "mp4", "pipe:1",
      ], { stdio: ["ignore", "pipe", "pipe"] });

      let stderr = "";
      child.stderr?.on("data", (chunk) => { stderr = `${stderr}${String(chunk)}`.slice(-2000); });
      res.on("close", () => { if (!res.writableEnded) child.kill("SIGKILL"); });

      countBytes(res, statMeta({ source: "download", url: stream.url, title, addonKey: stream.addonKey, addonName: stream.addonName, kind: media?.kind }));
      // No length is known ahead of an assembly, so the browser shows no progress bar.
      res.status(200).attachment(ticket.filename).setHeader("content-type", "video/mp4");

      child.on("error", () => { if (!res.headersSent) res.status(502).end(); else res.destroy(); });
      child.on("close", (code) => {
        if (code !== 0) log("WARN", "Assembling a playlist for a device failed", { filename: ticket.filename, code, stderr: stderr.slice(-400) });
        if (!res.writableEnded) res.end();
      });
      return void child.stdout!.pipe(res);
    }
    const controller = new AbortController();
    const headerTimeout = setTimeout(() => controller.abort(), 30_000);
    res.on("close", () => { if (!res.writableEnded) controller.abort(); });
    let upstream: Response;
    try { upstream = await safeFetch(stream.url!, { method: req.method === "HEAD" ? "HEAD" : "GET", headers, signal: controller.signal }); }
    finally { clearTimeout(headerTimeout); }
    if (!upstream.ok) { await upstream.body?.cancel(); throw new Error("Download source unavailable."); }

    countBytes(res, statMeta({ source: "download", url: stream.url, title, addonKey: stream.addonKey, addonName: stream.addonName, kind: media?.kind }));
    res.status(upstream.status).attachment(ticket.filename).setHeader("cache-control", "private, no-store");
    for (const name of ["content-type", "content-length", "content-range", "accept-ranges"]) {
      const value = upstream.headers.get(name); if (value) res.setHeader(name, value);
    }
    if (!upstream.body) return void res.end();
    const { Readable } = await import("node:stream");
    try { await pipeline(Readable.fromWeb(upstream.body as never), res, { signal: controller.signal }); }
    catch (error) { if (!res.destroyed && !res.writableEnded) throw error; }
  }));
}
