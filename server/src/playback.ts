import { AppError } from "./errors.js";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import { access, mkdir, readFile, rm, stat } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { mediaResources, safeSourceText } from "./media-resources.js";
import { createHash } from "node:crypto";
import { PlayerPreviews } from "./player-previews.js";
import { PlayerSidecars } from "./player-sidecars.js";
import { INTERNAL_TOKEN } from "./auth.js";
import { log } from "./logger.js";
import { pickByLanguage } from "./language.js";
import { ffmpegPath, trackMedia } from "./media-tools.js";
import { playlistArgs, probe, type MediaInfo, type Track } from "./probe.js";
import { safeFetch } from "./security.js";
import type { StreamItem } from "./types.js";

const REACHABILITY_TIMEOUT_MS = 8_000;

/** A one-byte range request is far cheaper than spawning ffprobe, so a source that is simply
 *  gone -- a dead torrent, an expired debrid link -- is ruled out before paying for that. Only
 *  a plain HTTP(S) address can be checked this way; a local file has nothing to connect to. */
export async function sourceReachable(stream: StreamItem, timeoutMs = REACHABILITY_TIMEOUT_MS): Promise<boolean> {
  if (!stream.url || !/^https?:\/\//i.test(stream.url)) return true;
  try {
    const response = await safeFetch(stream.url, {
      headers: { ...(stream.behaviorHints?.proxyHeaders?.request ?? {}), range: "bytes=0-0" },
      signal: AbortSignal.timeout(timeoutMs),
    });
    await response.body?.cancel().catch(() => undefined);
    return response.ok;
  } catch {
    return false;
  }
}

/** direct = the browser plays the file as is, remux = repackaging without re-encoding video, transcode = a real conversion. */
export type PlaybackMode = "direct" | "remux" | "transcode";

export interface ClientCapabilities {
  h264?: boolean; hevc?: boolean; hevc10?: boolean; vp8?: boolean; vp9?: boolean; av1?: boolean;
  aac?: boolean; mp3?: boolean; opus?: boolean; vorbis?: boolean; ac3?: boolean; eac3?: boolean; flac?: boolean;
}

export interface PlaybackOptions {
  audioLanguage?: string;
  subtitleLanguage?: string;
  audioTrack?: number;
  subtitleTrack?: number | null;
  startTime?: number;
  /** Maximum picture height; null or undefined = the original, with the video untouched. */
  quality?: number | null;
}

export interface PlaybackDescriptor {
  id: string; mode: PlaybackMode; url: string; offset: number;
  duration?: number; video?: string; audio?: string; hardware: boolean;
  /** Whether the server can transcode with hardware acceleration; unused in remux mode. */
  acceleration: boolean;
  audioTracks: Track[]; subtitleTracks: Track[];
  audioTrack: number; subtitleTrack: number | null;
  quality: number | null;
  sidecarUrl?: string;
  /**
   * Whether `url` addresses a playlist rather than the media. The client cannot
   * tell: a proxied source has no extension to read it from, and in direct mode
   * the difference decides whether the element can be handed the address at all.
   */
  playlist?: boolean;
}

/** The allowed target qualities and the video bitrate ceiling for each. */
/** What the source is called in the statistics. Shared with index.ts so transferred bytes
 * and started playbacks land in one entry instead of two nearly identical ones. */
/** A source that lists segments: by its address, or by what the probe made of it. */
export function isPlaylistSource(stream: StreamItem, info?: MediaInfo): boolean {
  const container = (info?.container ?? "").toLowerCase();
  if (container.split(",").some((token) => token.trim() === "hls")) return true;

  try {
    return new URL(stream.url ?? "").pathname.toLowerCase().endsWith(".m3u8");
  } catch {
    return false;
  }
}

export const sourceTitle = (stream: StreamItem) => stream.behaviorHints?.filename ?? stream.title ?? stream.name;

/** Whether `ffmpeg -version` names libx264 in its configure line, the software encoder transcodes use. */
export const hasSoftwareEncoder = (versionOutput: string) => /--enable-libx264\b/.test(versionOutput);

/** The hardware and software passes a conversion tries, in order. Copying the video needs neither. */
export function conversionAttempts(copyVideo: boolean, hardware: boolean, software: boolean): boolean[] {
  if (copyVideo || !hardware) return [false];
  return software ? [true, false] : [true];
}

export const QUALITY_BITRATE: Record<number, string> = { 1080: "6M", 720: "3M", 480: "1500k" };

/** One session as the statistics see it. The stream comes along whole, so the caller can
 * name the source the same way it names the traffic it counts. */
export interface ActiveSession {
  id: string; stream: StreamItem; mode: PlaybackMode; hardware: boolean;
  quality: number | null; duration?: number; startedAt: string; idleSeconds: number;
}

/** A simple operation queue for one session. A seek and a track change must not run
 * concurrently, because each restart creates and cleans up its own HLS generation. */
export class SerialOperations {
  private tail: Promise<void> = Promise.resolve();

  run<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.tail.then(operation, operation);
    this.tail = result.then(() => undefined, () => undefined);
    return result;
  }

  wait() { return this.tail; }
}

interface Session {
  id: string; stream: StreamItem; capabilities: ClientCapabilities; info?: MediaInfo;
  mode: PlaybackMode; generation: number; offset: number; hardware: boolean;
  audioTrack: number; subtitleTrack: number | null; quality: number | null;
  process?: ChildProcess; directory?: string; error?: string; startedAt: number; lastAccess: number; pendingKill?: Promise<void>;
  operations: SerialOperations; stopped: boolean;
  /** Until the client first loads it, a session is only a promise; an unclaimed one is closed after a while. */
  claimed: boolean;
  /** When the player itself last asked for anything. */
  clientAt?: number;
  /** The generation whose trailing requests are still served for a while after a restart. */
  retired?: { generation: number; directory: string; until: number };
  /** The client refused the copied stream, so this session must never copy again. */
  copyRejected?: boolean;
}

/** Main and Main 10 are two different codecs to a browser. A ten-bit stream must not be copied
 *  just because the browser handles eight-bit -- SourceBuffer would refuse it (bufferAddCodecError). */
const hevcPlayable = (video: MediaInfo["video"], caps: ClientCapabilities) => {
  const deep = /\b1[02]\b/.test(video?.profile ?? "") || /p1[02](le|be)$/i.test(video?.pixelFormat ?? "");
  return deep ? caps.hevc10 === true : caps.hevc === true;
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const DIRECT_MP4 = new Set([".mp4", ".m4v", ".mov"]);
const MP4_FORMAT = new Set(["mp4", "mov", "m4a", "m4v", "3gp", "3g2", "mj2", "ism"]);
const WEBM_VIDEO = new Set(["vp8", "vp9", "av1"]);
const WEBM_AUDIO = new Set(["opus", "vorbis"]);
const COPYABLE_AUDIO: Record<string, keyof ClientCapabilities> = { aac: "aac", mp3: "mp3", opus: "opus", ac3: "ac3", eac3: "eac3", flac: "flac" };

/** True when the client can start: one media segment whose init is named, or a finished short playlist.
 *  fMP4 lists the first segment while the decoder config is still being written. On a slow NAS that
 *  window is long enough for Safari to fetch a truncated init.mp4 and refuse the stream (code 3),
 *  and for Chrome to report bufferAddCodecError. EXT-X-MAP means the muxer finished the init. */
export const hlsCanStart = (playlist: string) => {
  if (playlist.includes("#EXT-X-ENDLIST") && !(playlist.match(/#EXTINF/g) ?? []).length) return true;
  return (playlist.match(/#EXTINF/g) ?? []).length >= 1 && /#EXT-X-MAP:URI="[^"]+"/i.test(playlist);
};

/** Init and segment files the playlist already names. All of them must exist before we hand the URL over. */
export const hlsPlaylistFiles = (playlist: string) => {
  const files: string[] = [];
  const map = playlist.match(/#EXT-X-MAP:URI="([^"]+)"/i);
  if (map && !map[1].includes("/") && !map[1].includes("\\")) files.push(map[1]);
  for (const line of playlist.split(/\r?\n/)) {
    const name = line.trim();
    if (name && !name.startsWith("#") && !name.includes("/") && !name.includes("\\")) files.push(name);
  }
  return files;
};

export async function waitForHlsOutput(directory: string, finished: () => boolean, cancelled: () => boolean, timeoutMs = 40_000): Promise<string | undefined> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline && !cancelled()) {
    try {
      const playlist = await readFile(path.join(directory, "index-0.m3u8"), "utf8");
      if (hlsCanStart(playlist)) {
        const files = await Promise.all(hlsPlaylistFiles(playlist).map((name) => stat(path.join(directory, name)).then((value) => value.size > 0, () => false)));
        if (files.every(Boolean)) return playlist;
      }
    } catch { /* FFmpeg has not published a playlist yet. */ }
    if (finished()) return;
    await sleep(100);
  }
}
// AC-3 family does not expose enough codec information to the fragmented MP4 muxer
// until the first packet arrives. After an input seek video can arrive first, making
// HLS fail while writing the init segment ("Cannot write moov atom before AC3 packets").
const AUDIO_REQUIRING_PACKET_FOR_FMP4 = new Set(["ac3", "eac3"]);
const IDLE_MS = 5 * 60_000;
// If the start finishes after the client gave up, the session and its FFmpeg hang around for
// five minutes, reading from the source the whole time. An unclaimed session has nothing to wait for.
const UNCLAIMED_MS = 45_000;
/** A session with nobody watching it. The player asks for a segment every couple of seconds and
 *  pings every thirty, so silence this long means it is gone -- and FFmpeg would otherwise convert
 *  and pull at the source for the whole idle limit with no one to show it to. */
const ORPHAN_MS = 90_000;
// Requests sent just before a transcode restart arrive at the new generation. hls.js treats a 404
// on a playlist as fatal, so the old generation is kept around for a while.
const RETIRED_MS = 15_000;
// The version probe is retried once with more room: a loaded host can push the first exec past
// the shorter limit, and losing the answer costs speed on every start and seek until a restart.
const VERSION_TIMEOUTS_MS = [10_000, 30_000];

/** Neither the log nor the user may see the source address -- it often carries an addon token. */
const redact = (text: string) => text.replace(/https?:\/\/\S+/g, "<zdroj>");
const NOISE = /you should use tag|deprecated|Last message repeated|^\s*$/i;
export const SOURCE_UNREACHABLE = "The source could not be opened: it did not answer, or it refused the connection.";

export const describeFailure = (stderr: string, code: number | null) => {
  const lines = redact(stderr).split(/\r?\n/).map((line) => line.trim()).filter((line) => line && !NOISE.test(line));
  // "Server returned 400 Bad Request" is our own proxy answering for a source that stays
  // silent or refuses the connection. Without a word about the source it reads like a
  // conversion error, which is the wrong place to go looking.
  if (lines.some((line) => /Error opening input/i.test(line)) && lines.some((line) => /Server returned \d{3}/i.test(line))) {
    return SOURCE_UNREACHABLE;
  }
  return lines.length ? lines.slice(-2).join(" ") : `FFmpeg exited with code ${code}.`;
};

export class PlaybackManager {
  private previews = new PlayerPreviews();
  private sessions = new Map<string, Session>();
  private inspected = new Map<string, { info?: MediaInfo; at: number }>();
  private inspecting = new Map<string, Promise<MediaInfo | undefined>>();
  private sidecars = new PlayerSidecars(undefined, (id, error) => {
    const reason = error instanceof Error ? error.message : String(error);
    log("WARN", "Embedded subtitles could not be extracted as a sidecar", { id, reason: reason.slice(0, 200) });
  });
  private readonly root: string;
  private vaapiDevice?: string;
  /** Some chips decode and encode but have no video processing unit, so scale_vaapi fails. */
  private vaapiScaling = true;
  /** Some drivers only offer constant quality, so a target bitrate makes the encoder refuse to open. */
  private vaapiBitrate = true;
  private vaapiFailures = 0;
  private videotoolbox = false;
  /** Intel Macs offer no constant-quality mode, so those encode at a fixed bitrate instead. */
  private videotoolboxQuality = false;
  private videotoolboxFailures = 0;
  /** -readrate_initial_burst exists only from FFmpeg 6; an older build would die on the option. */
  private initialBurst = false;
  /** An LGPL build, like the one the desktop app carries, has no libx264: hardware is all there is. */
  private softwareEncoder = true;
  private ffmpegVersion?: string;

  constructor(dataDir = process.env.DATA_DIR ?? "/data", private onStop: (id: string) => void = () => {}) { this.root = path.join(dataDir, "playback"); }

  async load() {
    await rm(this.root, { recursive: true, force: true });
    await mkdir(this.root, { recursive: true });
    const stdout = await this.readFfmpegVersion();
    if (stdout !== undefined) {
      this.ffmpegVersion = stdout.split("\n")[0]?.replace(/^ffmpeg version\s*/i, "").split(" ")[0];
      const major = Number(/version\s+n?(\d+)[.\s-]/.exec(stdout)?.[1]);
      this.initialBurst = major >= 6;
      if (!this.initialBurst) log("WARN", "FFmpeg is older than 6, start and seek will be slowed by the read rate limit", { major });
      this.softwareEncoder = hasSoftwareEncoder(stdout);
      if (!this.softwareEncoder) log("INFO", "This FFmpeg has no libx264, so a real transcode needs hardware encoding");
    }
    const device = process.env.VAAPI_DEVICE;
    if (device) await this.checkVaapi(device);
    // VideoToolbox is macOS-only. A VAAPI device on a Mac is a misconfiguration, and if it did come
    // up it wins; Linux and Docker never reach this line.
    if (process.platform === "darwin" && process.env.VIDEOTOOLBOX !== "0" && !this.vaapiDevice) await this.checkVideotoolbox();
    setInterval(() => this.reap(), 30_000).unref();
  }

  /** A cold container start can keep the first exec waiting on the disk past the timeout, and
   *  without the version the read rate limit stays on for every start and seek until a restart.
   *  A missing binary fails at once, so the second attempt only costs time when it can still help. */
  private async readFfmpegVersion() {
    let reason = "";
    for (const timeout of VERSION_TIMEOUTS_MS) {
      try {
        return (await promisify(execFile)(ffmpegPath(), ["-version"], { timeout })).stdout;
      } catch (error) {
        reason = error instanceof Error ? error.message : String(error);
      }
    }
    log("WARN", "FFmpeg version could not be determined, start and seek will be slowed by the read rate limit", { reason });
    return undefined;
  }

  /** A session nobody claims holds FFmpeg and the read from the source. An unclaimed session
   *  is a start the client never took up, and has no reason to wait out the whole idle limit. */
  private reap() {
    for (const session of [...this.sessions.values()]) {
      const unattended = Date.now() - (session.clientAt ?? session.startedAt);
      if (session.claimed && unattended > ORPHAN_MS) {
        log("INFO", "No player has asked for this session, closing it", { id: session.id, mode: session.mode, seconds: Math.round(unattended / 1000) });
        void this.stop(session.id); continue;
      }
      const idle = Date.now() - session.lastAccess;
      if (!session.claimed && session.mode !== "direct" && idle > UNCLAIMED_MS) {
        log("INFO", "Unclaimed session closed", { id: session.id, mode: session.mode, seconds: Math.round(idle / 1000) });
        void this.stop(session.id); continue;
      }
      if (idle > IDLE_MS) {
        log("INFO", "Idle session closed", { id: session.id, mode: session.mode, idleMinutes: Math.round(idle / 60_000) });
        void this.stop(session.id);
      }
    }
  }

  /** Reads the source tracks without starting playback; the result is held for a while so the source is left alone. */
  async inspect(stream: StreamItem): Promise<MediaInfo | undefined> {
    if (!stream.url) throw new AppError("This source has no direct address to play.", "err.noPlayableAddress");
    const key = this.inspectionKey(stream);
    const cached = this.inspected.get(key);
    if (cached && Date.now() - cached.at < 10 * 60_000) return cached.info;
    const inflight = this.inspecting.get(key);
    if (inflight) return inflight;
    const pending = this.loadInspection(stream);
    this.inspecting.set(key, pending);
    return pending;
  }

  private inspectionKey(stream: StreamItem) {
    return createHash("sha256").update(JSON.stringify([stream.url, stream.behaviorHints?.proxyHeaders?.request])).digest("hex");
  }

  private async loadInspection(stream: StreamItem) {
    try {
      const info = await this.probeSource(stream);
      log(info ? "INFO" : "WARN", info ? "Source inspected" : "Source could not be inspected (ffprobe found nothing usable)", {
        video: info?.video?.codec, duration: info?.duration ? Math.round(info.duration) : undefined,
        dolbyVisionEnhancementLayer: info?.video?.dolbyVisionEnhancementLayer,
        audio: info?.audioTracks.map((track) => `${track.codec}/${track.language ?? "?"}${track.title ? `/${track.title}` : ""}`),
        subtitles: info?.subtitleTracks.map((track) => `${track.codec}/${track.language ?? "?"}${track.title ? `/${track.title}` : ""}`),
      });
      if (this.inspected.size > 200) this.inspected.clear();
      this.inspected.set(this.inspectionKey(stream), { info, at: Date.now() });
      return info;
    } finally {
      this.inspecting.delete(this.inspectionKey(stream));
    }
  }

  private async probeSource(stream: StreamItem) {
    if (!(await sourceReachable(stream))) {
      log("INFO", "Source unreachable, ffprobe was skipped", { host: this.hostOf(stream.url) });
      return undefined;
    }
    return probe(this.localUrl(this.proxyPath(stream)));
  }

  private hostOf(url?: string) { try { return url ? new URL(url).hostname : undefined; } catch { return undefined; } }

  async start(stream: StreamItem, capabilities: ClientCapabilities = {}, options: PlaybackOptions = {}): Promise<PlaybackDescriptor> {
    if (!stream.url) throw new AppError("This source has no direct address to play.", "err.noPlayableAddress");
    const id = crypto.randomUUID();
    const source = this.proxyPath(stream);
    // Through inspect(), so the source list and the player never disagree about what the file holds.
    const info = await this.inspect(stream);
    const audioTracks = info?.audioTracks ?? [];
    const subtitleTracks = info?.subtitleTracks ?? [];

    const audioTrack = options.audioTrack ?? Math.max(0, pickByLanguage(audioTracks, options.audioLanguage));
    const subtitleTrack = options.subtitleTrack !== undefined
      ? options.subtitleTrack
      : this.preferredSubtitle(subtitleTracks, options.subtitleLanguage, audioTracks[audioTrack]?.language, options.audioLanguage);

    const quality = options.quality != null && QUALITY_BITRATE[options.quality] ? options.quality : null;
    const session: Session = {
      id, stream, capabilities, info, mode: "direct", generation: 0, offset: 0, hardware: false,
      audioTrack, subtitleTrack, quality, startedAt: Date.now(), lastAccess: Date.now(), operations: new SerialOperations(), stopped: false, claimed: false,
    };
    this.sessions.set(id, session);
    const summary = {
      video: info?.video?.codec, audio: info?.audio?.codec, audioTracks: audioTracks.length, subtitleTracks: subtitleTracks.length,
      dolbyVisionEnhancementLayer: info?.video?.dolbyVisionEnhancementLayer,
    };

    // Audio and quality decide conversion. Embedded subtitles always ride as a sidecar:
    // muxing WebVTT into fMP4 HLS makes the muxer die with "timescale not set".
    const avDefault = audioTrack === 0 && quality === null;
    const direct = this.directPlay(stream, info, capabilities);
    if (avDefault && direct.ok) {
      if (subtitleTrack !== null) this.extractSidecar(session);
      log("INFO", "Direct play from source", { id, reason: direct.reason, ...summary });
      return this.describe(session, source);
    }

    const plan = this.plan(session);
    session.mode = plan.copyVideo ? "remux" : "transcode";
    const reason = avDefault && subtitleTrack === null ? direct.reason : "a non-default track or quality was requested";
    try {
      const limit = info?.duration ? Math.max(0, info.duration - 2) : Number.POSITIVE_INFINITY;
      const startTime = Math.max(0, Math.min(options.startTime ?? 0, limit));
      const url = await this.spawnAt(session, startTime);
      if (subtitleTrack !== null) this.extractSidecar(session);
      log("INFO", "Conversion started", {
        id, mode: session.mode, reason, hardware: session.hardware,
        copyVideo: plan.copyVideo, copyAudio: plan.copyAudio,
        audioTrack, subtitleTrack, quality, startTime: Math.round(startTime), ...summary,
      });
      return this.describe(session, url);
    } catch (error) {
      log("ERROR", "Playback could not be started", { id, mode: session.mode, plan: reason, error });
      await this.stop(id); throw error;
    }
  }

  /** A seek outside the part already produced: FFmpeg restarts from the new position and the client shifts its timeline. */
  async seek(id: string, time: number) {
    const session = this.require(id);
    return session.operations.run(() => this.restart(session, time, "Playback seek"));
  }

  /** The browser refused what the server sent. Repeating it is pointless: the copy is dropped
   * and the session starts again as a real transcode. */
  async escalate(id: string, time: number) {
    const session = this.require(id);
    return session.operations.run(() => {
      const first = !session.copyRejected;
      session.copyRejected = true;
      return this.restart(session, time, first ? "Copy refused by the client, transcoding instead" : "Playback restarted after another decode error");
    });
  }

  /** Switching a track or the quality means new mappings or filters, so a restart from the current position. */
  async track(id: string, changes: { audio?: number; subtitle?: number | null; quality?: number | null; time?: number }) {
    const session = this.require(id);
    return session.operations.run(async () => {
      this.assertActive(session);
      if (changes.audio !== undefined) session.audioTrack = Math.max(0, changes.audio);
      if (changes.subtitle !== undefined) session.subtitleTrack = changes.subtitle;
      if (changes.quality !== undefined) session.quality = changes.quality != null && QUALITY_BITRATE[changes.quality] ? changes.quality : null;
      // Subtitles never ride in the conversion, they are read beside it. Restarting FFmpeg
      // for them would interrupt the picture and ask the source for another connection --
      // which is the one thing these hosts tend to refuse.
      if (changes.subtitle !== undefined && changes.audio === undefined && changes.quality === undefined) {
        if (session.subtitleTrack !== null) this.extractSidecar(session);
        else await this.sidecars.stop(id);
        log("INFO", "Subtitle track switched", { id, subtitleTrack: session.subtitleTrack, offset: Math.round(session.offset) });
        return this.describe(session, this.currentUrl(session));
      }
      // Going back to the original may satisfy the conditions for direct play again.
      if (session.quality === null && session.audioTrack === 0 && !session.copyRejected
        && this.canDirectPlay(session.stream, session.info, session.capabilities)) {
        session.pendingKill = this.kill(session);
        session.mode = "direct"; session.offset = 0;
        if (session.subtitleTrack !== null) this.extractSidecar(session);
        else await this.sidecars.stop(session.id);
        log("INFO", "Back to direct play", { id });
        return this.describe(session, this.proxyPath(session.stream));
      }
      return this.restart(session, changes.time ?? session.offset, "Track or quality switched");
    });
  }

  private async restart(session: Session, time: number, message: string) {
    try { return await this.restartConversion(session, time, message); }
    catch (error) {
      if (!session.stopped && session.subtitleTrack !== null) this.extractSidecar(session);
      throw error;
    }
  }

  private async restartConversion(session: Session, time: number, message: string) {
    this.assertActive(session);
    const id = session.id;
    const limit = session.info?.duration ? Math.max(0, session.info.duration - 2) : Number.POSITIVE_INFINITY;
    const target = Math.max(0, Math.min(time, limit));
    // The source usually allows one connection at a time, so the subtitle reader lets
    // go of it before the conversion asks for its own.
    await this.sidecars.release(id);
    this.assertActive(session);
    // What is playing is worth more than the seek: the film keeps running while the new position
    // is opened, so a source that refuses the connection costs the viewer a jump, not the film.
    const playing = { process: session.process, generation: session.generation, directory: session.directory, offset: session.offset, mode: session.mode, retired: session.retired };
    if (session.mode === "direct") session.mode = this.plan(session).copyVideo ? "remux" : "transcode";
    session.offset = target;
    let url: string;
    try { url = await this.spawnAt(session, target); }
    catch (error) {
      this.assertActive(session);
      log("WARN", "Conversion restart failed, trying once more", { id, offset: Math.round(target), reason: error instanceof Error ? error.message : String(error) });
      await sleep(1000);
      this.assertActive(session);
      try { url = await this.spawnAt(session, target); }
      catch (again) {
        // Put the session back on what it was playing, which is still running and still has the
        // one connection the source did give us.
        if (playing.process && playing.process.exitCode === null && playing.process.signalCode === null) {
          Object.assign(session, playing);
          log("WARN", "The new position could not be opened, the film carries on where it was", { id, wanted: Math.round(target), playing: Math.round(playing.offset) });
        }
        throw again;
      }
    }
    // Only now is there something to play instead of it.
    session.pendingKill = this.killChild(playing.process);
    if (session.subtitleTrack !== null) this.extractSidecar(session);
    // Whether the restart ended up on the GPU is worth knowing: a transcode that says
    // nothing looks the same in the log as one that quietly fell back to the processor.
    log("INFO", message, { id, offset: Math.round(target), mode: session.mode, hardware: session.hardware, audioTrack: session.audioTrack, subtitleTrack: session.subtitleTrack });
    return this.describe(session, url);
  }

  async preview(id: string, time: number, signal: AbortSignal) {
    const session = this.playing(id);
    if (!session || !Number.isFinite(time) || time < 0) return undefined;
    const at = Math.min(time, Math.max(0, (session.info?.duration ?? time + 1) - 0.1));
    return this.previews.frame(id, this.localUrl(this.proxyPath(session.stream)), at, signal);
  }

  touch(id: string) {
    const session = this.sessions.get(id);
    if (session) { session.lastAccess = Date.now(); session.claimed = true; }
  }

  /** The player itself asked for something -- a segment, a ping, a seek. FFmpeg reading the
   *  source does not count: an abandoned session reads on quite happily. */
  attended(id: string) {
    const session = this.sessions.get(id);
    if (session) { session.clientAt = Date.now(); session.lastAccess = Date.now(); session.claimed = true; }
  }

  async stop(id: string) {
    this.previews.stop(id);
    const session = this.sessions.get(id);
    if (!session) return;
    log("DEBUG", "Playback session stopped", { id, mode: session.mode, generation: session.generation, position: Math.round(session.offset) });
    session.stopped = true;
    this.sessions.delete(id);
    await Promise.all([this.sidecars.stop(id), this.kill(session)]);
    this.onStop(id);
    await session.operations.wait();
    await this.kill(session);
    await this.purgeNow(path.join(this.root, id));
  }

  /** What is playing right now, for the statistics. The bytes are not here: they are counted
   * where they flow, in the proxy, and joined to the session by its id. */
  active(now = Date.now()): ActiveSession[] {
    return [...this.sessions.values()].map((session) => ({
      id: session.id,
      stream: session.stream,
      mode: session.mode,
      hardware: session.hardware,
      quality: session.quality,
      duration: session.info?.duration,
      startedAt: new Date(session.startedAt).toISOString(),
      idleSeconds: Math.round((now - session.lastAccess) / 1000),
    }));
  }

  /** Overview for diagnostics: what the server can do and what is running right now. */
  diagnostics() {
    return {
      ffmpeg: { version: this.ffmpegVersion, initialBurst: this.initialBurst, softwareEncoder: this.softwareEncoder },
      vaapi: { device: this.vaapiDevice, scaling: this.vaapiScaling, bitrate: this.vaapiBitrate, failures: this.vaapiFailures },
      videotoolbox: { available: this.videotoolbox, constantQuality: this.videotoolboxQuality, failures: this.videotoolboxFailures },
      sessions: [...this.sessions.values()].map((session) => ({
        id: session.id, mode: session.mode, hardware: session.hardware, generation: session.generation,
        title: sourceTitle(session.stream) || undefined,
        video: session.info?.video?.codec, audio: session.info?.audio?.codec,
        audioTrack: session.audioTrack, subtitleTrack: session.subtitleTrack, quality: session.quality,
        offset: Math.round(session.offset), idleSeconds: Math.round((Date.now() - session.lastAccess) / 1000),
      })),
    };
  }

  directory(id: string, generation: string) {
    const session = this.playing(id);
    if (!session) return undefined;
    const retired = session.retired;
    const directory = String(session.generation) === generation ? session.directory
      : retired && String(retired.generation) === generation && retired.until > Date.now() ? retired.directory
      : undefined;
    if (!directory) return undefined;
    session.claimed = true;
    session.lastAccess = Date.now();
    return directory;
  }

  private require(id: string) {
    const session = this.playing(id);
    if (!session) throw new AppError("The playback session no longer exists.", "err.playbackSessionGone");
    return session;
  }

  /** A session the player let go of is nobody's to read or steer until it is taken back:
   *  from outside the server the film is over, whatever FFmpeg is still doing inside it. */
  private playing(id: string) {
    const session = this.sessions.get(id);
    return session && !session.stopped ? session : undefined;
  }

  private assertActive(session: Session) {
    if (session.stopped || this.sessions.get(session.id) !== session) throw new AppError("The playback session no longer exists.", "err.playbackSessionGone");
  }

  private describe(session: Session, url: string): PlaybackDescriptor {
    return {
      id: session.id, mode: session.mode, url, offset: session.offset,
      duration: session.info?.duration, video: session.info?.video?.codec, audio: session.info?.audio?.codec,
      hardware: session.hardware, acceleration: Boolean(this.vaapiDevice || this.videotoolbox),
      audioTracks: (session.info?.audioTracks ?? []).map((track) => ({ ...track, title: safeSourceText(track.title, session.stream) })),
      subtitleTracks: (session.info?.subtitleTracks ?? []).map((track) => ({ ...track, title: safeSourceText(track.title, session.stream) })),
      audioTrack: session.audioTrack, subtitleTrack: session.subtitleTrack, quality: session.quality,
      sidecarUrl: session.subtitleTrack !== null ? this.sidecarUrl(session) : undefined,
      playlist: session.mode === "direct" ? isPlaylistSource(session.stream, session.info) : true,
    };
  }

  async sidecar(id: string, revision: string | undefined, offset: number, delay = 0, position: number | null = offset) {
    const session = this.playing(id);
    if (!session || session.subtitleTrack === null) return undefined;
    const cues = await this.sidecars.read(id, revision, offset, delay, position);
    if (!cues) return undefined;
    session.claimed = true;
    session.lastAccess = Date.now();
    return cues;
  }

  /** What the player is playing right now: the generation being written, or the file itself. */
  private currentUrl(session: Session) {
    return session.mode === "direct"
      ? this.proxyPath(session.stream)
      : `/api/playback/${session.id}/${session.generation}/master.m3u8`;
  }

  /** The offset rides in the address: a seek only re-reads the same cues, shifted. */
  private sidecarUrl(session: Session) {
    const revision = this.sidecars.revision(session.id);
    if (!revision) return undefined;
    return `/api/playback/${session.id}/sidecar.vtt?revision=${revision}&offset=${session.offset.toFixed(3)}`;
  }

  private extractSidecar(session: Session) {
    const index = session.subtitleTrack;
    if (index === null) return;
    const source = this.localUrl(this.proxyPath(session.stream));
    const playlist = isPlaylistSource(session.stream, session.info);
    this.sidecars.ensure(session.id, path.join(this.root, session.id), index, session.offset, async (start) => [
      "-hide_banner", "-loglevel", "error", "-nostdin",
      // The sidecar reads from the same remote host as the conversion and can lose the
      // connection the same way. Reconnecting keeps the cue timestamps coming without
      // starting the extraction from a different source position.
      "-reconnect", "1", "-reconnect_streamed", "1", "-reconnect_on_network_error", "1", "-reconnect_delay_max", "10",
      // The same playlist through the same demuxer, so the same flags -- and the same
      // reason to leave them out when the source is an ordinary file.
      ...(playlist ? await playlistArgs("ffmpeg") : []),
      ...(start > 0 ? ["-ss", start.toFixed(3)] : []),
      // An input seek lands on the packet before the requested time, not on it, so
      // without -copyts the cues would be rebased to an unknown point -- minutes off.
      // Source timestamps keep them aligned whatever the seek actually hit.
      "-copyts", "-start_at_zero",
      "-i", source,
      "-map", `0:s:${index}`, "-c:s", "webvtt",
    ]);
  }

  /** Embedded subtitles are switched on by themselves only when the preferred language really matches. */
  /** What a viewer who has not chosen a track themselves is given. Someone who understands
   *  what is being said wants only the lines spoken in another language -- the forced track --
   *  and nothing at all when the film carries none. Someone who does not understand it wants
   *  the film subtitled: in their language when it is there, in English when it is not. */
  private preferredSubtitle(tracks: Track[], preferred?: string, spoken?: string, understood?: string): number | null {
    if (!tracks.length) return null;
    const inLanguage = (language?: string) => language ? tracks.filter((track) => track.language === language) : [];
    if (understood && spoken === understood) return inLanguage(preferred).find((track) => track.forced)?.index ?? null;
    // A forced track subtitles a handful of lines, so a full one is worth more even in the
    // second language: the point here is to follow a film nobody in the room can otherwise.
    const offered = [...inLanguage(preferred), ...inLanguage("en")];
    return (offered.find((track) => !track.forced) ?? offered[0])?.index ?? null;
  }

  private proxyPath(stream: StreamItem) { return mediaResources.path(stream); }
  /** A call from inside the server proves itself with the process token, having no browser cookie. */
  private localUrl(relative: string) {
    return `http://127.0.0.1:${process.env.PORT ?? 8080}${relative}${relative.includes("?") ? "&" : "?"}token=${INTERNAL_TOKEN}`;
  }

  private extension(stream: StreamItem) {
    let name = stream.behaviorHints?.filename ?? "";
    if (!name) { try { name = new URL(stream.url!).pathname; } catch { name = ""; } }
    return path.extname(name).toLowerCase();
  }

  /** Probe beats a misleading filename: a Matroska file named .mp4 is not MP4. */
  private directKind(stream: StreamItem, info: MediaInfo): "mp4" | "webm" | "other" {
    const extension = this.extension(stream);
    const tokens = new Set((info.container ?? "").toLowerCase().split(",").map((item) => item.trim()).filter(Boolean));
    if ([...tokens].some((token) => MP4_FORMAT.has(token))) return "mp4";
    const video = info.video?.codec ?? "";
    if ((tokens.has("webm") || tokens.has("matroska")) && WEBM_VIDEO.has(video)) return "webm";
    if (tokens.has("matroska") || tokens.has("webm")) return "other";
    if (DIRECT_MP4.has(extension)) return "mp4";
    if (extension === ".webm") return "webm";
    return "other";
  }

  /** The cheapest path: a file the browser handles on its own. Seeking then runs natively over HTTP Range.
   * A refusal carries its reason: "why is this being transcoded" is the first question about any playback
   * problem, and without it nobody can answer it from the log. */
  private directPlay(stream: StreamItem, info: MediaInfo | undefined, caps: ClientCapabilities): { ok: boolean; reason: string } {
    if (stream.behaviorHints?.notWebReady) return { ok: false, reason: "addon marks the source as not web ready" };
    if (!info?.video) return { ok: false, reason: "source has no probed video stream" };
    const kind = this.directKind(stream, info);
    const extension = this.extension(stream);
    const video = info.video.codec;
    const audio = info.audio?.codec;
    if (kind === "mp4") {
      if (!(video === "h264" || (video === "hevc" && hevcPlayable(info.video, caps)))) {
        return { ok: false, reason: `client cannot play video codec ${video || "unknown"}${info.video.profile ? ` (${info.video.profile})` : ""}` };
      }
      if (audio && audio !== "aac" && audio !== "mp3") return { ok: false, reason: `audio codec ${audio} is not playable in mp4` };
      return { ok: true, reason: "container and codecs are playable as they are" };
    }
    if (kind === "webm") {
      if (!(video === "vp8" || video === "vp9" || (video === "av1" && caps.av1 === true))) {
        return { ok: false, reason: `client cannot play video codec ${video || "unknown"} in webm` };
      }
      if (audio && !WEBM_AUDIO.has(audio)) return { ok: false, reason: `audio codec ${audio} is not playable in webm` };
      return { ok: true, reason: "container and codecs are playable as they are" };
    }
    return { ok: false, reason: `container ${info.container || extension || "unknown"} is not directly playable` };
  }
  private canDirectPlay(stream: StreamItem, info: MediaInfo | undefined, caps: ClientCapabilities) {
    return this.directPlay(stream, info, caps).ok;
  }

  /** A device that exists and opens is not proof that it can encode: on some builds libva
   * fails only when the context is created. So one tiny frame is actually encoded and the
   * result decides, not a guess -- otherwise every playback would pay for a several-second
   * attempt that fails anyway. */
  private async checkVaapi(device: string) {
    try { await access(device, constants.R_OK | constants.W_OK); }
    catch {
      // Report which group actually owns the device and which ones the process holds:
      // otherwise finding the right RENDER_GID means a trip to the container terminal.
      let owner: number | undefined;
      try { owner = (await stat(device)).gid; } catch { /* device may be gone entirely */ }
      log("WARN", "VAAPI_DEVICE is not accessible, conversion will run in software. Set RENDER_GID in .env to the deviceGroup value below", {
        device,
        deviceGroup: owner,
        ourGroups: process.getgroups?.() ?? [],
        runningAs: `${process.getuid?.()}:${process.getgid?.()}`,
      });
      return;
    }
    try {
      await this.runVaapiProbe(device, "format=nv12,hwupload");
      this.vaapiDevice = device;
      // Encoding working says nothing about scaling: the video processing unit is a
      // separate piece and DSM chips often lack it. Probing the encoder alone would
      // let playback fail later with "the requested VAProfile is not supported".
      this.vaapiScaling = await this.probeVaapi(device, "format=nv12,hwupload,scale_vaapi=w=128:h=72:format=nv12");
      this.vaapiBitrate = await this.probeVaapi(device, "format=nv12,hwupload", ["-b:v", "1M", "-maxrate", "1M"]);
      log("INFO", "VAAPI is available", { device, gpuScaling: this.vaapiScaling, bitrateControl: this.vaapiBitrate });
      if (!this.vaapiScaling) log("INFO", "The GPU cannot scale, downscaling will run on the processor", { device });
      if (!this.vaapiBitrate) log("INFO", "The GPU cannot target a bitrate, encoding at constant quality instead", { device });
    } catch (error) {
      const output = (error as { stderr?: string }).stderr ?? String(error);
      const reason = output.split("\n").map((line) => line.trim()).filter(Boolean)[0] ?? "unknown error";
      log("WARN", "VAAPI does not work, conversion will run in software. Try setting LIBVA_DRIVER_NAME=iHD or i965 in .env; vainfo in the container terminal has the details", { device, reason });
    }
  }

  private async runVaapiProbe(device: string, filters: string, encoder: string[] = []) {
    await promisify(execFile)(ffmpegPath(), [
      "-hide_banner", "-loglevel", "error", "-nostdin",
      "-init_hw_device", `vaapi=va:${device}`, "-filter_hw_device", "va",
      "-f", "lavfi", "-i", "nullsrc=s=256x144:d=0.1",
      "-vf", filters, "-c:v", "h264_vaapi", ...encoder, "-f", "null", "-",
    ], { timeout: 30_000 });
  }

  private async probeVaapi(device: string, filters: string, encoder: string[] = []) {
    try { await this.runVaapiProbe(device, filters, encoder); return true; }
    catch { return false; }
  }

  /** VideoToolbox is always there on a Mac, but a frame is still encoded: the encoder can fail
   *  even when the framework loads, and only the result says whether a conversion would work. */
  /** The hardware path a conversion started now would use. VAAPI wins where both are set. */
  private accelerator(): "vaapi" | "videotoolbox" | null {
    return this.vaapiDevice ? "vaapi" : this.videotoolbox ? "videotoolbox" : null;
  }

  private async checkVideotoolbox() {
    try {
      await this.runVideotoolboxProbe(["-q:v", "60"]);
      this.videotoolbox = true;
      this.videotoolboxQuality = true;
      log("INFO", "VideoToolbox is available", { constantQuality: true });
      return;
    } catch { /* Intel Macs have no constant-quality mode; the bitrate probe decides. */ }
    try {
      await this.runVideotoolboxProbe(["-b:v", "1M"]);
      this.videotoolbox = true;
      log("INFO", "VideoToolbox is available", { constantQuality: false });
    } catch (error) {
      const output = (error as { stderr?: string }).stderr ?? String(error);
      const reason = output.split("\n").map((line) => line.trim()).filter(Boolean)[0] ?? "unknown error";
      log("WARN", "VideoToolbox does not work, conversion will run in software", { reason });
    }
  }

  private async runVideotoolboxProbe(encoder: string[]) {
    await promisify(execFile)(ffmpegPath(), [
      "-hide_banner", "-loglevel", "error", "-nostdin",
      "-f", "lavfi", "-i", "nullsrc=s=256x144:d=0.1",
      "-vf", "format=nv12", "-c:v", "h264_videotoolbox", ...encoder, "-f", "null", "-",
    ], { timeout: 30_000 });
  }

  /** Emby calls this Direct Stream: the container is repackaged, the video only copied. */
  private plan(session: Session) {
    const caps = session.capabilities;
    const video = session.info?.video?.codec ?? "";
    const audio = session.info?.audioTracks?.[session.audioTrack]?.codec ?? session.info?.audio?.codec ?? "";
    // A lower chosen quality forces a real transcode; a copy would carry the original resolution.
    // A refused copy says the probe and the capability list disagreed with the real decoder.
    // Which stream was to blame is unknowable from here, so both go through the encoder.
    const copyVideo = !session.copyRejected && session.quality === null
      && ((video === "h264" && caps.h264 !== false) || (video === "hevc" && hevcPlayable(session.info?.video, caps)));
    const audioCapability = COPYABLE_AUDIO[audio];
    return { copyVideo, copyAudio: !session.copyRejected && Boolean(audioCapability && caps[audioCapability] === true) };
  }

  private async spawnAt(session: Session, offset: number): Promise<string> {
    this.assertActive(session);
    const previous = session.directory;
    session.generation += 1;
    session.offset = offset;
    const directory = path.join(this.root, session.id, String(session.generation));
    await mkdir(directory, { recursive: true });
    this.assertActive(session);
    session.directory = directory;
    session.lastAccess = Date.now();
    // Cleanup can only follow the old process's real end, or the two reach into the same directory.
    if (previous) {
      const retired = { generation: session.generation - 1, directory: previous, until: Date.now() + RETIRED_MS };
      session.retired = retired;
      void (session.pendingKill ?? Promise.resolve()).then(async () => {
        await sleep(Math.max(0, retired.until - Date.now()));
        if (session.retired === retired) session.retired = undefined;
        // Unless the film went back to it: a position that could not be opened leaves the
        // old generation playing, and it is the one thing that must not be deleted.
        if (session.directory !== previous) await this.purge(previous, "a generation that was replaced");
      });
    }

    const { copyVideo } = this.plan(session);
    session.mode = copyVideo ? "remux" : "transcode";
    // Decided once: a concurrent session can switch a path off while this one awaits, and the
    // failure below has to be charged to the path this attempt actually used.
    const accelerator = this.accelerator();
    const attempts = conversionAttempts(copyVideo, accelerator !== null, this.softwareEncoder);
    let firstAttempt = true;
    for (const hardware of attempts) {
      this.assertActive(session);
      if (!firstAttempt) {
        // A failed VAAPI pass leaves a playlist the wait loop would accept, so software
        // would return that broken init instead of writing its own.
        await this.purge(directory, "a conversion attempt that failed");
        await mkdir(directory, { recursive: true });
      }
      firstAttempt = false;
      const url = await this.run(session, offset, directory, hardware);
      if (url) return url;
      // A source that answers 404 will answer the same to the software attempt.
      if (session.error === SOURCE_UNREACHABLE) break;
      if (hardware) {
        if (accelerator === "videotoolbox") {
          log("WARN", "VideoToolbox failed, falling back to a software conversion", { id: session.id, reason: session.error });
          this.videotoolboxFailures += 1;
          // Without libx264 there is nothing to fall back to: switching the path off would turn
          // two passing failures into every transcode failing until a restart.
          if (this.videotoolboxFailures >= 2 && this.softwareEncoder) {
            this.videotoolbox = false;
            log("WARN", "VideoToolbox failed repeatedly, it will not be used again until restart", { failures: this.videotoolboxFailures });
          }
        } else {
          log("WARN", "VAAPI failed, falling back to a software conversion", { id: session.id, reason: session.error });
          // A driver that refuses twice will refuse every time, and each attempt costs the
          // viewer about twenty seconds before playback starts. Stop offering it.
          this.vaapiFailures += 1;
          if (this.vaapiFailures >= 2 && this.softwareEncoder) {
            this.vaapiDevice = undefined;
            log("WARN", "VAAPI failed repeatedly, it will not be used again until restart", { failures: this.vaapiFailures });
          }
        }
      }
    }
    throw new AppError(session.error || "The video conversion could not be started.", "err.conversionFailed");
  }

  private async run(session: Session, offset: number, directory: string, hardware: boolean) {
    // Only for a source that really is a playlist: these are HLS demuxer options, and FFmpeg
    // rejects them outright -- "Option not found" -- when the input is an ordinary file.
    // Resolved here rather than inside args(): asking the binary what it supports is I/O, and
    // args() stays synchronous so it can be read and tested as the pure list-builder it is.
    const playlist = isPlaylistSource(session.stream, session.info) ? await playlistArgs("ffmpeg") : [];
    const args = this.args(session, offset, directory, hardware, playlist);
    const startedAt = Date.now();
    log("DEBUG", "FFmpeg starting", {
      id: session.id, generation: session.generation, mode: session.mode, hardware,
      offset: Math.round(offset), args: args.join(" "),
    });
    const child = trackMedia(spawn(ffmpegPath(), args, { stdio: ["ignore", "ignore", "pipe"] }));
    session.process = child; session.hardware = hardware; session.error = undefined;
    const generation = session.generation;
    let stderr = ""; let finished = false; let exitCode: number | null = null; let handedToClient = false;
    child.stderr?.on("data", (chunk) => { stderr = `${stderr}${String(chunk)}`.slice(-16_000); });
    child.once("error", (error) => { finished = true; session.error = error.message; });
    // Only 'close' guarantees stderr has been read; 'exit' routinely misses the last message.
    child.once("close", (code, signal) => {
      finished = true; exitCode = code;
      // Our own SIGTERM comes back as a plain exit, and taking it for a failure would leave the
      // session carrying an error that never happened -- and the log claiming one.
      const asked = this.stopping.has(child);
      if (code !== 0 && signal === null && !asked) session.error = describeFailure(stderr, code);
      // A conversion that died after the client attached would otherwise stay silent until
      // the player reports a stall, with no clue whether the source or FFmpeg was at fault.
      if (handedToClient && code !== 0 && signal === null && !asked && !session.stopped) {
        log("WARN", "FFmpeg stopped after playback had started", { id: session.id, generation, code, reason: session.error, stderr: redact(stderr).slice(-500) });
      }
    });

    const url = `/api/playback/${session.id}/${session.generation}/master.m3u8`;
    const output = await waitForHlsOutput(directory, () => finished, () => session.stopped);
    if (session.stopped) {
      child.kill("SIGTERM");
      log("DEBUG", "Conversion abandoned, the session is gone", { id: session.id, generation: session.generation, ms: Date.now() - startedAt });
      return undefined;
    }
    if (output !== undefined) {
      handedToClient = true;
      const segments = (output.match(/#EXTINF/g) ?? []).length;
      log("DEBUG", "FFmpeg is producing segments", { id: session.id, generation: session.generation, hardware, segments, ms: Date.now() - startedAt });
      return url;
    }
    if (!finished) { child.kill("SIGKILL"); session.error ||= "The conversion did not get going within 40 seconds."; }
    session.error ||= describeFailure(stderr, exitCode);
    log("ERROR", "The conversion could not be started", {
      id: session.id, offset: Math.round(offset), mode: session.mode, hardware, exitCode,
      audioTrack: session.audioTrack, subtitleTrack: session.subtitleTrack,
      reason: session.error,
      args: args.join(" "), waitedMs: Date.now() - startedAt,
      stderr: redact(stderr).slice(-1500),
    });
    return undefined;
  }

  private args(session: Session, offset: number, directory: string, hardware: boolean, playlist: string[] = []) {
    const { copyVideo, copyAudio } = this.plan(session);
    const quality = session.quality;
    const bitrate = quality !== null ? QUALITY_BITRATE[quality] : undefined;
    // Read here, after the awaits that came before: a path switched off meanwhile gives the
    // software arguments rather than a VAAPI command with no device.
    const accel = hardware ? this.accelerator() : null;
    const sourceVideo = session.info?.video?.codec ?? "";
    // The mappings and var_stream_map must match exactly what the file really holds. A question mark
    // in -map drops a missing track quietly, but the hls muxer then looks for it in vain and dies on the header.
    const audioCount = session.info?.audioTracks.length ?? 1;
    const hasAudio = !session.info || audioCount > 0;
    const audioIndex = Math.min(session.audioTrack, Math.max(0, audioCount - 1));
    const crf = process.env.FFMPEG_CRF ?? "23";
    // VAAPI CQP and libx264 CRF are different modes. Compatibility with the single original
    // value stays, but new installs can tune them independently.
    const vaapiQp = process.env.VAAPI_QP ?? crf;
    const args = ["-hide_banner", "-loglevel", "warning", "-nostdin"];
    // -ss before -i seeks over HTTP Range, so nothing before the wanted position is transferred.
    // With a copied video the audio must start on a keyframe too (noaccurate_seek): trimming the
    // audio exactly would leave the video ahead, and the player answers that gap with drifting sync.
    if (offset > 0) {
      if (copyVideo) args.push("-noaccurate_seek");
      args.push("-ss", offset.toFixed(3));
    }
    // Where VAAPI video processing works, decoding, scaling and encoding can all stay on the
    // GPU. The weaker Intel GPUs in a Synology often manage the encoder only. In that case
    // FFmpeg gets no -hwaccel: it decodes and scales in RAM, and the explicitly initialised
    // device is used only by hwupload + h264_vaapi. That avoids the troublesome trip of VAAPI
    // surfaces back into system memory.
    if (!copyVideo && accel) {
      // VideoToolbox decodes on the media engine and hands frames back in system memory, so the
      // ordinary filters below need no upload -- unlike the VAAPI branch.
      if (accel === "videotoolbox") {
        args.push("-hwaccel", "videotoolbox");
      } else if (this.vaapiScaling) {
        args.push("-hwaccel", "vaapi", "-hwaccel_device", this.vaapiDevice!, "-hwaccel_output_format", "vaapi");
      } else {
        args.push("-init_hw_device", `vaapi=va:${this.vaapiDevice!}`, "-filter_hw_device", "va");
      }
    }
    // FFmpeg 7.1 does not know the hvcE Block Addition Mapping used by some Dolby Vision
    // Matroska files. Under the default strictness that unknown mapping is a fatal input
    // error; unofficial lets the copy continue without the enhancement layer.
    if (copyVideo && sourceVideo === "hevc") args.push("-strict", "unofficial");
    // Remote hosts drop a connection now and then, especially on a deep range seek into a
    // large file. Without these options FFmpeg treats that as the end of the input and the
    // conversion dies after the first segment, leaving the player stalled.
    args.push("-reconnect", "1", "-reconnect_streamed", "1", "-reconnect_on_network_error", "1", "-reconnect_delay_max", "10");
    // A lead is paid for in disk writes: repackaging at 8x real time pours ~340 MB out of
    // FFmpeg in 20 s and a weaker NAS chokes pushing dirty pages through.
    // Three keeps seeking just as brisk (the initial burst is what counts) at a third of the writes.
    args.push("-readrate", copyVideo ? process.env.FFMPEG_READRATE_REMUX ?? "3" : process.env.FFMPEG_READRATE ?? "1.5");
    // The first few dozen seconds are read at full speed so the first segment is ready as soon as
    // possible; only then does the brake against downloading the whole file step in.
    if (this.initialBurst) args.push("-readrate_initial_burst", process.env.FFMPEG_BURST ?? "30");
    // Every playlist entry comes back from our own proxy as /api/media/<id>, which has no file
    // ending at all, and the HLS demuxer refuses a segment whose ending is not on its list. An
    // HLS source therefore probed fine and then failed to convert, which reaches the viewer as
    // "the conversion could not be started". ffprobe and downloads already ask for these; the
    // conversion reads the same playlists and needs them just as much.
    args.push(...playlist);
    args.push("-i", this.localUrl(this.proxyPath(session.stream)));
    args.push("-map", "0:v:0?");
    if (hasAudio) args.push("-map", `0:a:${audioIndex}?`);
    args.push("-map_metadata", "-1", "-map_chapters", "-1", "-dn");
    // A copied video after -ss starts at the keyframe before the target, so its timestamps are negative.
    // fMP4 cannot write those and would shift each track on its own -- the audio would drift by the
    // distance to that keyframe. make_zero shifts every track alike and keeps them in sync.
    args.push("-avoid_negative_ts", "make_zero");

    if (copyVideo) {
      args.push("-c:v", "copy");
      // Safari plays HEVC in fMP4 only under the hvc1 tag; with the default hev1 it refuses the stream.
      if (sourceVideo === "hevc") {
        args.push("-tag:v", "hvc1");
        // Not the dvcC/dvvC box with it, whatever the source carries: a segment that announces
        // Dolby Vision comes back from the browser as "SourceBuffer error" and never plays.
        // The picture underneath is ordinary HEVC, and that is what the player is given.
      }
    }
    // A keyframe every 2 s keeps segments short: HLS may only cut on keyframes, so a longer GOP
    // would stretch the wait for the first segment after a start and after every seek.
    // min(quality, ih) stops the picture being blown up when the source is smaller than the chosen quality.
    else if (accel === "videotoolbox") {
      // h264 wants 8-bit 4:2:0, and VideoToolbox frames are already in system memory, so an
      // ordinary scale filter works where the VAAPI branch needs one on the GPU.
      const filters = quality !== null ? `scale=-2:min(${quality}\\,ih),format=nv12` : "format=nv12";
      args.push("-vf", filters, "-c:v", "h264_videotoolbox");
      if (bitrate) args.push("-b:v", bitrate, "-maxrate", bitrate);
      // Intel Macs offer no constant-quality mode, so they are given a plain bitrate instead.
      else if (this.videotoolboxQuality) args.push("-q:v", process.env.VIDEOTOOLBOX_QUALITY ?? "60");
      else args.push("-b:v", "8M");
      args.push("-g", "48", "-force_key_frames", "expr:gte(t,n_forced*2)");
    } else if (accel === "vaapi") {
      const resize = quality !== null ? `w=-2:h=min(${quality}\\,ih)` : "";
      const filters = this.vaapiScaling
        ? (quality !== null ? `scale_vaapi=${resize}:format=nv12` : "scale_vaapi=format=nv12")
        // Scaling on the processor is still far cheaper than encoding, so the encoder stays on the GPU.
        : (quality !== null ? `scale=${resize},format=nv12,hwupload` : "format=nv12,hwupload");
      args.push("-vf", filters, "-c:v", "h264_vaapi");
      if (bitrate && this.vaapiBitrate) args.push("-b:v", bitrate, "-maxrate", bitrate);
      else args.push("-qp", vaapiQp);
      args.push("-g", "48", "-force_key_frames", "expr:gte(t,n_forced*2)");
    } else {
      if (quality !== null) args.push("-vf", `scale=-2:min(${quality}\\,ih)`);
      args.push("-c:v", "libx264", "-preset", process.env.FFMPEG_PRESET ?? "veryfast", "-crf", crf, "-pix_fmt", "yuv420p", "-force_key_frames", "expr:gte(t,n_forced*2)");
      if (bitrate) args.push("-maxrate", bitrate, "-bufsize", bitrate);
    }
    // Audio passthrough makes sense only for a remux. While the picture is transcoded, copied
    // E-AC-3 in particular can block fMP4 HLS initialisation ("codec frame size is not set").
    // AAC is the most reliable for web clients and converting it costs the NAS almost nothing.
    const selectedAudioCodec = session.info?.audioTracks[audioIndex]?.codec ?? session.info?.audio?.codec ?? "";
    const passthroughAudio = copyVideo && copyAudio
      && !(offset > 0 && AUDIO_REQUIRING_PACKET_FOR_FMP4.has(selectedAudioCodec));
    // AAC arrives from an HLS source in ADTS frames, and fMP4 wants it in ASC. Copied through
    // unchanged the muxer refuses every packet -- "Malformed AAC bitstream detected", then
    // "Error submitting a packet to the muxer" -- and FFmpeg dies before it writes the stream
    // line of the master playlist. The client is then handed a master with no CODECS and no
    // variant at all, which Chrome reports as bufferAddCodecError and Safari as refusing the
    // source outright. The filter only rewrites ADTS, so AAC that is already ASC passes by.
    // Only playlist sources carry ADTS; applying it to a file is unnecessary.
    const adtsToAsc = passthroughAudio && selectedAudioCodec === "aac"
      && isPlaylistSource(session.stream, session.info)
      ? ["-bsf:a", "aac_adtstoasc"] : [];
    if (hasAudio) args.push(...(passthroughAudio ? ["-c:a", "copy", ...adtsToAsc] : ["-c:a", "aac", "-ac", "2", "-b:a", "160k"]));

    // fMP4 segments: the only way to let HEVC or AC3 through without re-encoding.
    // Embedded subtitles stay out of this mux: WebVTT in fMP4 HLS dies with "timescale not set".
    args.push("-f", "hls", "-hls_time", "2", "-hls_list_size", "0", "-hls_playlist_type", "event",
      "-hls_segment_type", "fmp4", "-hls_flags", "independent_segments+temp_file", "-hls_fmp4_init_filename", "init.mp4",
      "-master_pl_name", "master.m3u8",
      "-var_stream_map", hasAudio ? "v:0,a:0" : "v:0",
      "-hls_segment_filename", path.join(directory, "seg-%v-%06d.m4s"), path.join(directory, "index-%v.m3u8"));
    return args;
  }

  /** Waits for the process to really end: while FFmpeg lives it writes segments and the directory cannot be deleted. */
  /** FFmpeg answers SIGTERM by exiting 255 without a word, which is indistinguishable from a
   *  conversion that died on its own unless we remember that we asked. */
  private stopping = new WeakSet<ChildProcess>();

  private kill(session: Session): Promise<void> {
    const child = session.process;
    session.process = undefined;
    return this.killChild(child);
  }

  private killChild(child?: ChildProcess): Promise<void> {
    if (!child || child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
    this.stopping.add(child);
    return new Promise((resolve) => {
      const force = setTimeout(() => child.kill("SIGKILL"), 3000);
      const giveUp = setTimeout(() => resolve(), 6000);
      child.once("exit", () => { clearTimeout(force); clearTimeout(giveUp); resolve(); });
      child.kill("SIGTERM");
    });
  }

  /** Deleting the directory a conversion is writing into takes the film down with it: the HLS
   *  muxer cannot rename its playlist and exits. Whoever asks, the one that is playing stays. */
  private async purge(directory: string, why = "cleanup") {
    // A conversion that has already died leaves its directory to be cleaned up -- the retry after
    // a failed hardware attempt depends on that. Only a process still writing there is protected.
    const playing = [...this.sessions.values()].find((session) =>
      session.directory === directory && !session.stopped
      && session.process !== undefined && session.process.exitCode === null && session.process.signalCode === null);
    if (playing) {
      log("WARN", "Refused to delete the generation that is playing", { id: playing.id, generation: playing.generation, why });
      return;
    }
    log("DEBUG", "Deleting a playback directory", { directory, why });
    return this.purgeNow(directory);
  }

  private async purgeNow(directory: string) {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try { await rm(directory, { recursive: true, force: true }); return; }
      catch { await sleep(200); }
    }
    log("WARN", "The session directory could not be cleaned up", { directory });
  }
}
