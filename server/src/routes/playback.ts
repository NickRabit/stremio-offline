import type express from "express";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { AirPlayAccess } from "../airplay-access.js";
import { INTERNAL_TOKEN } from "../auth.js";
import { normalizeLanguage } from "../language.js";
import { log } from "../logger.js";
import { mediaChildPath, mediaResources, openMediaUrl, ResourceError, safeSourceText, type ResourceOwner } from "../media-resources.js";
import { readMediaText, rewritePlaylist } from "../media-playlist.js";
import type { ClientCapabilities, PlaybackManager, PlaybackOptions } from "../playback.js";
import type { RangeCache } from "../range-cache.js";
import { redirectedHeaders, safeFetch, validateRemoteUrl } from "../security.js";
import type { StatsLog, TrafficMeta } from "../stats.js";
import type { UserPrefs } from "../store.js";
import type { StreamItem } from "../types.js";
import { asyncRoute, type RouteContext } from "./context.js";

/** Inspection, the playback sessions and the media reader. */
export interface PlaybackDeps extends RouteContext {
  airplayAccess: AirPlayAccess;
  airplayRequest(req: express.Request): ReturnType<AirPlayAccess["authorize"]>;
  answerHeaders(upstream: Response): Record<string, string>;
  countBytes(res: express.Response, meta: TrafficMeta, session?: string): void;
  httpSourceOf(req: express.Request): Promise<StreamItem>;
  internalMediaRequest(req: express.Request): boolean;
  libraryTarget(value: string): Promise<string>;
  noteSourceQuiet(key: string): void;
  ownerOf(req: express.Request): ResourceOwner;
  playback: PlaybackManager;
  playbackMeta(stream: StreamItem): TrafficMeta;
  playbackOwners: Map<string, { owner: ResourceOwner; resourceId: string }>;
  playbackResponse: <T extends { id: string; url: string }>(value: T) => T;
  prefsOf(req?: express.Request): UserPrefs;
  quietSources: Map<string, number>;
  rangeCache: RangeCache;
  safeInspection(info: Awaited<ReturnType<PlaybackManager["inspect"]>>, stream: StreamItem): {
    duration: number | undefined;
    video: { codec: string | undefined; width: number | undefined; height: number | undefined } | undefined;
    audioTracks: Array<{ title: string | undefined; language: string | undefined; codec: string | undefined }>;
    subtitleTracks: Array<{ title: string | undefined; language: string | undefined; codec: string | undefined }>;
  };
  sleep(ms: number): Promise<unknown>;
  sourceIsQuiet(key: string): boolean;
  stats: StatsLog;
  subtitleDelay(value: unknown): number;
  trackMedia(owner: ResourceOwner, res: express.Response, resourceId?: string): void;
  SOURCE_ATTEMPTS: number;
  SOURCE_RETRY_MS: number;
  SOURCE_RESUMES: number;
  SOURCE_HEADER_MS: number;
  SOURCE_QUIET_HEADER_MS: number;
}

export function registerPlaybackRoutes(app: express.Application, deps: PlaybackDeps): void {
  const { airplayAccess, airplayRequest, answerHeaders, countBytes, currentSession, currentUser, httpSourceOf, internalMediaRequest, libraryTarget, noteSourceQuiet, ownerOf, playback, playbackMeta, playbackOwners, playbackResponse, prefsOf, quietSources, rangeCache, safeInspection, sleep, sourceIsQuiet, stats, subtitleDelay, trackMedia, SOURCE_ATTEMPTS, SOURCE_RETRY_MS, SOURCE_RESUMES, SOURCE_HEADER_MS, SOURCE_QUIET_HEADER_MS } = deps;

  app.post("/api/inspect", asyncRoute(async (req, res) => {
    const stream = await httpSourceOf(req);
    const info = await playback.inspect(stream);
    res.setHeader("cache-control", "private, no-store").json(safeInspection(info, stream));
  }));
  app.post("/api/playback", asyncRoute(async (req, res) => {
    const settings = prefsOf(req);
    const options: PlaybackOptions = { audioLanguage: settings.audioLanguage, subtitleLanguage: settings.subtitleLanguage };
    if (req.body.audioLanguage !== undefined) options.audioLanguage = normalizeLanguage(String(req.body.audioLanguage)) ?? settings.audioLanguage;
    if (req.body.subtitleLanguage !== undefined) {
      if (req.body.subtitleLanguage === null) options.subtitleTrack = null;
      else options.subtitleLanguage = normalizeLanguage(String(req.body.subtitleLanguage)) ?? settings.subtitleLanguage;
    }
    if (req.body.audioTrack !== undefined) options.audioTrack = Number(req.body.audioTrack);
    if (req.body.subtitleTrack !== undefined) options.subtitleTrack = req.body.subtitleTrack === null ? null : Number(req.body.subtitleTrack);
    if (req.body.time !== undefined) options.startTime = Math.max(0, Number(req.body.time) || 0);
    if (req.body.quality !== undefined) options.quality = req.body.quality === null ? null : Number(req.body.quality);
    const owner = ownerOf(req);
    const prepared = mediaResources.mediaStream(await httpSourceOf(req), owner);
    let started;
    const subtitleIds: Record<string, string> = {};
    try {
      if (req.body.subtitleIds !== undefined && (!Array.isArray(req.body.subtitleIds) || req.body.subtitleIds.length > 100)) throw new ResourceError(400, "INVALID_SUBTITLES");
      for (const id of req.body.subtitleIds ?? []) {
        if (typeof id !== "string") throw new ResourceError(400, "INVALID_SUBTITLES");
        const subtitle = mediaResources.get(id, owner.sid, "subtitle");
        subtitleIds[id] = mediaResources.add(subtitle.stream, owner, "subtitle", prepared.resourceId);
      }
      started = await playback.start(prepared.stream, req.body.capabilities as ClientCapabilities, options);
      if (currentSession(req)?.sid !== owner.sid) {
        await playback.stop(started.id);
        throw new ResourceError(401, "AUTH_REQUIRED");
      }
      playbackOwners.set(started.id, { owner, resourceId: prepared.resourceId });
      if (req.body.capabilities?.airplay === true) airplayAccess.create(started.id, owner, prepared.resourceId);
    } catch (error) { mediaResources.remove(prepared.resourceId); throw error; }
    // Bytes are counted by the proxy or by the library; only the item itself is added here,
    // so that "how much there was" is not limited to downloads.
    void stats.complete(playbackMeta(prepared.stream));
    res.status(201).setHeader("cache-control", "private, no-store").json({ ...playbackResponse(started), subtitleIds });
  }));
  app.use("/api/playback/:id", (req, res, next) => {
    const owned = playbackOwners.get(String(req.params.id));
    if (!owned || owned.owner.sid !== (airplayRequest(req)?.owner.sid ?? currentSession(req)?.sid)) return res.status(404).json({ error: "Playback session unavailable.", code: "RESOURCE_NOT_FOUND" });
    res.setHeader("cache-control", "private, no-store");
    playback.attended(String(req.params.id));
    next();
  });
  app.get("/api/playback/:id/preview", asyncRoute(async (req, res) => {
    const controller = new AbortController();
    res.once("close", () => { if (!res.writableEnded) controller.abort(); });
    const image = await playback.preview(String(req.params.id), Number(req.query.time), controller.signal);
    if (res.destroyed) return;
    if (!image) return void res.status(204).end();
    res.type("image/jpeg").setHeader("cache-control", "private, no-store").send(image);
  }));
  app.post("/api/playback/:id/ping", (_req, res) => res.status(204).end());
  app.post("/api/playback/:id/seek", asyncRoute(async (req, res) => res.json(playbackResponse(await playback.seek(String(req.params.id), Number(req.body.time) || 0)))));
  app.post("/api/playback/:id/escalate", asyncRoute(async (req, res) => res.json(playbackResponse(await playback.escalate(String(req.params.id), Number(req.body.time) || 0)))));
  app.post("/api/playback/:id/track", asyncRoute(async (req, res) => res.json(playbackResponse(await playback.track(String(req.params.id), {
    audio: req.body.audio === undefined ? undefined : Number(req.body.audio),
    subtitle: req.body.subtitle === undefined ? undefined : (req.body.subtitle === null ? null : Number(req.body.subtitle)),
    quality: req.body.quality === undefined ? undefined : (req.body.quality === null ? null : Number(req.body.quality)),
    time: Number(req.body.time) || 0,
  })))));
  app.delete("/api/playback/:id", asyncRoute(async (req, res) => {
    // Who closed a session is the difference between a viewer leaving and the server giving up.
    log("INFO", "Playback session closed by the player", { id: String(req.params.id), user: currentUser(req)?.username });
    await playback.stop(String(req.params.id));
    res.status(204).end();
  }));
  app.get("/api/playback/:id/sidecar.vtt", asyncRoute(async (req, res) => {
    const offset = Math.max(0, Number(req.query.offset) || 0);
    const requestedPosition = Number(req.query.position);
    const position = Number.isFinite(requestedPosition) ? Math.max(offset, requestedPosition) : null;
    const cues = await playback.sidecar(
      String(req.params.id),
      typeof req.query.revision === "string" ? req.query.revision : undefined,
      offset,
      subtitleDelay(req.query.delay),
      position,
    );
    if (!cues) return res.status(404).end();
    // Until the reader has the whole track the player keeps asking, so it is told which it has.
    // How far the cues reach: the player re-reads before the picture catches up with them.
    res.type("text/vtt; charset=utf-8").setHeader("cache-control", "private, no-store")
      .setHeader("x-sidecar-complete", cues.complete ? "1" : "0")
      .setHeader("x-sidecar-coverage", Number.isFinite(cues.coverage) ? String(Math.round(cues.coverage)) : "")
      .send(cues.text);
  }));
  app.get("/api/playback/:id/:generation/:file", asyncRoute(async (req, res) => {
    const directory = playback.directory(String(req.params.id), String(req.params.generation));
    // After a transcode restart the client asks for the old generation for a while; a 404 is fine
    // for that, but repeated 404s on a live session mean playback has fallen apart.
    if (!directory) { log("DEBUG", "Segment from an unknown session or generation", { req: req.id, id: req.params.id, generation: req.params.generation, file: req.params.file }); return res.status(404).end(); }
    const file = String(req.params.file);
    const grant = airplayRequest(req);
    const receiverPlaylist = (text: string) => grant ? rewritePlaylist(text, (uri) => {
      if (!/^[A-Za-z0-9_-]{1,64}\.(m3u8|mp4|m4s|vtt)$/.test(uri)) throw new Error("Unsupported AirPlay playlist resource.");
      return airplayAccess.url(grant.playbackId, uri);
    }) : text;
    // With no slashes and no dots the name cannot escape the session directory.
    if (!/^[A-Za-z0-9_-]{1,64}\.(m3u8|mp4|m4s|vtt)$/.test(file)) return res.status(400).end();
    if (file === "master.m3u8") {
      // FFmpeg writes the variant line only when it exits, so while it runs the master playlist
      // is just a header and hls.js fails on it with manifestParsingError. We assemble it ourselves.
      // FFmpeg also writes HEVC as hvc1.1.4.L120.B01, while browsers accept only the B0 form and
      // would refuse the stream before trying it; with no attribute they read the codecs from the init segment.
      const playlist = await readFile(path.join(directory, file), "utf8").catch(() => "");
      if (playlist.includes("#EXT-X-STREAM-INF")) {
        return void res.type("application/vnd.apple.mpegurl").setHeader("cache-control", "private, no-store")
          .send(receiverPlaylist(playlist.replace(/CODECS="[^"]*"/g, "").replace(/:,+/g, ":").replace(/,{2,}/g, ",").replace(/,\s*$/gm, "")));
      }
      const hasSubtitles = await readFile(path.join(directory, "index-0_vtt.m3u8"), "utf8").then(() => true, () => false);
      const lines = ["#EXTM3U", "#EXT-X-VERSION:7"];
      if (hasSubtitles) lines.push('#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",NAME="Titulky",DEFAULT=YES,AUTOSELECT=YES,URI="index-0_vtt.m3u8"');
      lines.push(`#EXT-X-STREAM-INF:BANDWIDTH=8000000${hasSubtitles ? ',SUBTITLES="subs"' : ""}`, "index-0.m3u8");
      return void res.type("application/vnd.apple.mpegurl").setHeader("cache-control", "private, no-store").send(receiverPlaylist(`${lines.join("\n")}\n`));
    }
    if (file.endsWith(".m3u8")) {
      res.type("application/vnd.apple.mpegurl").setHeader("cache-control", "private, no-store");
      if (grant) {
        const playlist = await readFile(path.join(directory, file), "utf8").catch(() => undefined);
        return void (playlist === undefined ? res.status(404).end() : res.send(receiverPlaylist(playlist)));
      }
    }
    else { if (file.endsWith(".vtt")) res.type("text/vtt; charset=utf-8"); res.setHeader("cache-control", "private, no-store"); }
    res.sendFile(file, { root: directory, dotfiles: "deny" }, (error) => { if (error && !res.headersSent) res.status(404).end(); });
  }));

  app.get(["/api/media/:resourceId", "/api/media/:resourceId/u/:signed"], asyncRoute(async (req, res) => {
    res.setHeader("cache-control", "private, no-store");
    if ("url" in req.query || "headers" in req.query) throw new ResourceError(400, "UNSAFE_SOURCE_INPUT");
    const internal = internalMediaRequest(req);
    const grant = airplayRequest(req);
    const resource = mediaResources.get(String(req.params.resourceId), grant?.owner.sid ?? currentSession(req)?.sid, "media", internal);
    trackMedia(grant ? { ...resource.owner, expiresAt: grant.expiresAt } : resource.owner, res, resource.parent ?? resource.id);
    let stream = resource.stream;
    if (typeof req.params.signed === "string") {
      const url = openMediaUrl(resource.id, req.params.signed);
      if (!url) throw new ResourceError(404, "RESOURCE_NOT_FOUND");
      const child = new URL(url);
      if (!["http:", "https:"].includes(child.protocol) || child.username || child.password) throw new Error("Unsupported playlist resource.");
      const headers = redirectedHeaders(stream.behaviorHints?.proxyHeaders?.request ?? {}, new URL(stream.url!), child);
      stream = { ...stream, url: child.toString(), behaviorHints: { ...stream.behaviorHints, proxyHeaders: { request: Object.fromEntries(headers) } } };
    }
    const raw = stream.url!;
    const ownedSession = [...playbackOwners].find(([, value]) => value.resourceId === (resource.parent ?? resource.id))?.[0];
    if (ownedSession) {
      playback.touch(ownedSession);
      const heartbeat = setInterval(() => playback.touch(ownedSession), 30_000);
      res.once("close", () => clearInterval(heartbeat));
    }
    if (raw.startsWith("file://")) {
      const relative = raw.slice(7);
      const target = await libraryTarget(relative);
      countBytes(res, { source: "library", provider: "knihovna", title: path.basename(relative), kind: "other" }, ownedSession);
      return void res.sendFile(path.basename(target), { root: path.dirname(target), acceptRanges: true, dotfiles: "deny" }, (error) => {
        if (error && !res.headersSent) res.status(404).end();
      });
    }
    await validateRemoteUrl(raw);
    countBytes(res, playbackMeta(stream), ownedSession);
    const cacheKey = `${resource.parent ?? resource.id}:${typeof req.params.signed === "string" ? req.params.signed : ""}`;
    const askedRange = String(req.headers.range ?? "");
    const held = req.method === "HEAD" ? undefined : rangeCache.get(cacheKey, askedRange);
    let alreadySent = 0;
    if (held) {
      // A reader that opens a film reads its header and stops; what it needs is here, and the
      // source hears nothing. Only a reader that keeps going is handed on to it, from where this
      // leaves off.
      res.status(held.status);
      for (const [name, value] of Object.entries(held.headers)) res.setHeader(name, value);
      if (!res.write(held.bytes)) await once(res, "drain");
      alreadySent = held.bytes.length;
      log("DEBUG", "Served a read the source had already answered", { req: req.id, range: askedRange || "whole file", bytes: alreadySent, whole: held.complete });
      if (held.complete) return void res.end();
      // The moment's grace is what tells a header probe from a reader that wants the film.
      await new Promise((resolve) => setTimeout(resolve, 50));
      if (res.destroyed || res.writableEnded) return;
    }
    const headers: Record<string, string> = { ...stream.behaviorHints?.proxyHeaders?.request };
    if (req.headers.range) headers.range = req.headers.range;
    // Handed on from where the cached start left off, so the source is asked only for the rest.
    if (alreadySent) headers.range = `bytes=${Number(/bytes=(\d*)-/.exec(askedRange)?.[1] || 0) + alreadySent}-${/bytes=\d*-(\d+)/.exec(askedRange)?.[1] ?? ""}`;
    const controller = new AbortController();
    let headerTimedOut = false;
    const quiet = sourceIsQuiet(resource.parent ?? resource.id);
    const headerTimeout = setTimeout(() => { headerTimedOut = true; controller.abort(); }, quiet ? SOURCE_QUIET_HEADER_MS : SOURCE_HEADER_MS);
    // Seek and stop close the previous Range. Without aborting here the old
    // upstream keeps downloading from the debrid host and starves the new one.
    //
    // `!res.writableEnded` is the whole point: this fires for a response that was cut, not one
    // that finished. Whoever tears a transfer down must therefore destroy it. `res.end()` sets
    // `writableEnded`, the abort never runs, and the source reads on until it times out -- which
    // shows up as a seek that buffers forever under load, not as an error anyone can find.
    // Callers that rely on this: the PlaybackManager release hook, and stopOwnedPlayback.
    res.on("close", () => { if (!res.writableEnded) controller.abort(); });
    // These hosts drop a connection now and then, on a range deep into a large file as
    // readily as on the first byte. Handing that straight to FFmpeg ends the conversion and
    // the viewer's seek with it, so a dropped request is asked again before it is given up on.
    let upstream: Response;
    for (let attempt = 1; ; attempt += 1) {
      try { upstream = await safeFetch(raw, { method: req.method === "HEAD" ? "HEAD" : "GET", headers, signal: controller.signal }); break; }
      catch (error) {
        if (res.destroyed || res.writableEnded) {
          clearTimeout(headerTimeout);
          log("DEBUG", "The client closed the transfer", { req: req.id, url: raw, range: req.headers.range });
          return;
        }
        const reason = headerTimedOut ? "no response within 30 s" : (error instanceof Error ? error.message : String(error));
        // A timeout or a viewer who left is not worth repeating; a dropped connection is.
        if (attempt >= (quiet ? 1 : SOURCE_ATTEMPTS) || headerTimedOut || controller.signal.aborted) {
          clearTimeout(headerTimeout);
          noteSourceQuiet(resource.parent ?? resource.id);
          log("WARN", "The source did not respond", { req: req.id, url: raw, range: req.headers.range, reason, attempts: attempt, quiet });
          throw error;
        }
        log("WARN", "The source dropped the request, asking again", { req: req.id, url: raw, range: req.headers.range, reason, attempt });
        await sleep(SOURCE_RETRY_MS * attempt);
      }
    }
    clearTimeout(headerTimeout);
    // It answered, so it is not the host that has stopped talking to us.
    quietSources.delete(resource.parent ?? resource.id);
    if (res.destroyed || res.writableEnded) {
      await upstream.body?.cancel().catch(() => undefined);
      return;
    }
    if (upstream.status >= 400) log("WARN", "The source refused the request", { req: req.id, url: raw, status: upstream.status, range: req.headers.range });
    if (![200, 206].includes(upstream.status)) {
      await upstream.body?.cancel().catch(() => undefined);
      if (upstream.status === 416) {
        const range = upstream.headers.get("content-range");
        if (range && /^bytes \*\/\d+$/.test(range)) res.setHeader("content-range", range);
        return void res.status(416).end();
      }
      return void res.status(502).json({ error: "Media source request failed." });
    }
    const contentType = upstream.headers.get("content-type") ?? "";
    if (contentType.includes("dash+xml") || new URL(upstream.url).pathname.toLowerCase().endsWith(".mpd")) {
      await upstream.body?.cancel();
      throw new Error("DASH playlists are not supported by the media proxy.");
    }
    if (req.method !== "HEAD" && (contentType.includes("mpegurl") || new URL(upstream.url).pathname.toLowerCase().endsWith(".m3u8"))) {
      const proxied = (value: string) => {
        const child = new URL(value, upstream.url);
        if (!["http:", "https:"].includes(child.protocol) || child.username || child.password) throw new Error("Unsupported playlist resource.");
        const path = mediaChildPath(resource.parent ?? resource.id, child.toString());
        const url = `${path}${internal ? `?token=${INTERNAL_TOKEN}` : ""}`;
        return grant ? airplayAccess.url(grant.playbackId, url) : url;
      };
      const playlist = rewritePlaylist(await readMediaText(upstream), proxied, (text) => safeSourceText(text, stream) ?? "");
      if (res.destroyed || res.writableEnded) return;
      res.status(upstream.status).type("application/vnd.apple.mpegurl").setHeader("cache-control", "private, no-store").send(playlist);
      return;
    }
    if (!alreadySent) {
      res.status(upstream.status);
      for (const name of ["content-type", "content-length", "content-range", "accept-ranges"]) { const value = upstream.headers.get(name); if (value) res.setHeader(name, value); }
    }
    if (!upstream.body) return res.end();
    const { Readable } = await import("node:stream");
    // These hosts hand over a few seconds and then cut the stream. FFmpeg answers that by
    // reconnecting on its own -- another connection into a host that is counting them, and one
    // it usually refuses. The transfer is picked up here instead, from the byte it stopped at,
    // so what FFmpeg reads is one unbroken response.
    const asked = /bytes=(\d*)-(\d*)/.exec(req.headers.range ?? "");
    const from = Number(asked?.[1] || 0) + alreadySent;
    const until = asked?.[2] ? Number(asked[2]) : undefined;
    const expected = Number(upstream.headers.get("content-length") ?? "") || undefined;
    let delivered = 0;
    // Worth keeping only while it is still short: a longer read is the picture going by.
    let keep: Buffer[] | undefined = req.method === "GET" ? [] : undefined;
    let kept = 0;
    let body: ReadableStream | null = upstream.body;
    for (let resumed = 0; ; ) {
      let broke: unknown;
      try {
        for await (const chunk of Readable.fromWeb(body as never)) {
          // Never more than was asked for: a source picking the transfer up runs to the end of the
          // file, and a body longer than the length already promised breaks the response itself.
          const piece = expected === undefined ? chunk as Buffer : (chunk as Buffer).subarray(0, expected - delivered);
          delivered += piece.length;
          if (keep) {
            kept += piece.length;
            if (kept > rangeCache.limit) keep = undefined; else keep.push(Buffer.from(piece));
          }
          if (piece.length && !res.write(piece)) await once(res, "drain");
          if (expected !== undefined && delivered >= expected) break;
        }
      } catch (error) { broke = error; }
      if (res.destroyed || res.writableEnded || controller.signal.aborted) {
        // What it read before it left is what the next one will ask for first.
        if (keep && !alreadySent && delivered) {
          rangeCache.put(cacheKey, askedRange, { status: upstream.status, headers: answerHeaders(upstream), bytes: Buffer.concat(keep), complete: false });
        }
        log("DEBUG", "The client closed the transfer", { req: req.id, url: raw, range: req.headers.range });
        return;
      }
      const short = expected !== undefined && delivered < expected;
      if (!broke && !short) {
        if (keep && !alreadySent && expected !== undefined && delivered === expected) {
          rangeCache.put(cacheKey, askedRange, { status: upstream.status, headers: answerHeaders(upstream), bytes: Buffer.concat(keep), complete: true });
        }
        break;
      }
      if (resumed >= SOURCE_RESUMES || expected === undefined || !short) {
        noteSourceQuiet(resource.parent ?? resource.id);
        log("WARN", "The transfer from the source broke off", {
          req: req.id, url: raw, range: req.headers.range, delivered, expected, resumed,
          reason: broke instanceof Error ? broke.message : broke === undefined ? "it ended early" : String(broke),
        });
        throw broke ?? new Error("The source ended the transfer early.");
      }
      resumed += 1;
      log("WARN", "The transfer broke off, picking it up where it stopped", { req: req.id, url: raw, at: from + delivered, delivered, expected, resumed });
      await sleep(SOURCE_RETRY_MS * resumed);
      const resumeRange = `bytes=${from + delivered}-${until !== undefined ? until : ""}`;
      const next = await safeFetch(raw, { headers: { ...headers, range: resumeRange }, signal: controller.signal }).catch(() => undefined);
      if (!next || ![200, 206].includes(next.status) || !next.body) {
        await next?.body?.cancel().catch(() => undefined);
        noteSourceQuiet(resource.parent ?? resource.id);
        log("WARN", "The source would not pick the transfer up", { req: req.id, url: raw, at: from + delivered, status: next?.status });
        throw broke ?? new Error("The source ended the transfer early.");
      }
      body = next.body;
    }
    res.end();
  }));
}
