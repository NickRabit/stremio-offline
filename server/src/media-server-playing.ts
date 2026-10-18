import { randomUUID } from "node:crypto";
import { log } from "./logger.js";
import type { MediaServerAuthority, MediaServerManager } from "./media-server-manager.js";
import type { ProviderPlaybackReport } from "./media-server-provider.js";
import { MediaServerError, isMediaServerError } from "./media-server-types.js";

export type PlaybackEvent = "start" | "progress" | "stop";

export interface PlaybackReport {
  mediaSourceId: string;
  position: number;
  paused: boolean;
  event: PlaybackEvent;
}

export interface PlaybackReporterSeams {
  clock?: () => number;
  idleMs?: number;
  sweepMs?: number;
  maxSessions?: number;
  newSessionId?: () => string;
}

const invalid = (message: string): MediaServerError => new MediaServerError("invalid-input", message);
const REPORT_KEYS = ["mediaSourceId", "position", "paused", "event"];
const PLAYBACK_EVENTS = new Set<PlaybackEvent>(["start", "progress", "stop"]);
const PLAYBACK_REFUSAL_CODES = new Set([
  "playback-not-allowed", "no-compatible-stream", "rate-limited", "bitrate-limit",
  "unsupported-policy", "forbidden",
]);
const MEDIA_SOURCE_ID_MAX = 256;
const POSITION_MAX = 10_000_000;
const TICKS_PER_SECOND = 10_000_000;

export function readPlaybackReport(body: unknown): PlaybackReport {
  if (typeof body !== "object" || body === null || Array.isArray(body)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(body))) {
    throw invalid("The playback report is malformed.");
  }
  for (const key of Reflect.ownKeys(body)) {
    const descriptor = typeof key === "string" ? Object.getOwnPropertyDescriptor(body, key) : undefined;
    if (typeof key !== "string" || !descriptor || !("value" in descriptor)) {
      throw invalid("The playback report is malformed.");
    }
  }
  const record = body as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!REPORT_KEYS.includes(key)) throw invalid("The playback report has an unknown field.");
  }
  for (const key of REPORT_KEYS) {
    if (!Object.hasOwn(record, key)) throw invalid(`The playback report is missing ${key}.`);
  }
  if (typeof record.mediaSourceId !== "string") throw invalid("The playback media source id is malformed.");
  const mediaSourceId = record.mediaSourceId.trim();
  if (mediaSourceId.length === 0 || mediaSourceId.length > MEDIA_SOURCE_ID_MAX) {
    throw invalid("The playback media source id is malformed.");
  }
  const position = record.position;
  if (typeof position !== "number" || !Number.isFinite(position) || position < 0 || position > POSITION_MAX) {
    throw invalid("The playback position is out of range.");
  }
  if (typeof record.paused !== "boolean") throw invalid("The playback pause flag must be a boolean.");
  if (typeof record.event !== "string" || !PLAYBACK_EVENTS.has(record.event as PlaybackEvent)) {
    throw invalid("The playback event is not allowed.");
  }
  return { mediaSourceId, position, paused: record.paused, event: record.event as PlaybackEvent };
}

interface LivePlayback {
  key: string;
  actorId: string;
  libraryId: string;
  itemId: string;
  mediaSourceId: string;
  playSessionId: string;
  providerPlaySessionId?: string;
  position: number;
  paused: boolean;
  lastSeen: number;
}

const playbackKey = (actorId: string, libraryId: string, itemId: string, mediaSourceId: string): string =>
  [actorId, libraryId, itemId, mediaSourceId].join("\u0000");

export class MediaServerPlaybackReporter {
  private readonly clock: () => number;
  private readonly idleMs: number;
  private readonly sweepMs: number;
  private readonly maxSessions: number;
  private readonly newSessionId: () => string;
  private readonly live = new Map<string, LivePlayback>();
  private readonly refused = new Map<string, true>();
  private readonly tails = new Map<string, Promise<void>>();
  private timer: ReturnType<typeof setInterval> | undefined;
  private closing: Promise<void> | undefined;
  private closed = false;

  constructor(
    private readonly manager: Pick<MediaServerManager, "reportPlayback">,
    private readonly authorityFor: (actorId: string) => MediaServerAuthority | undefined,
    seams: PlaybackReporterSeams = {},
  ) {
    this.clock = seams.clock ?? Date.now;
    this.idleMs = seams.idleMs ?? 60_000;
    this.sweepMs = seams.sweepMs ?? 15_000;
    this.maxSessions = seams.maxSessions ?? 32;
    this.newSessionId = seams.newSessionId ?? (() => randomUUID().replaceAll("-", ""));
  }

  async report(authority: MediaServerAuthority, libraryId: string, itemId: string, report: PlaybackReport): Promise<void> {
    try {
      if (this.closed) return;
      const key = playbackKey(authority.actor.id, libraryId, itemId, report.mediaSourceId);
      const current = this.live.get(key);
      if (report.event === "stop") {
        if (!current) return;
        this.clearRefusal(key);
        current.position = report.position;
        current.paused = report.paused;
        this.live.delete(key);
        await this.send(current, authority, "stopped");
        return;
      }

      if (!current) {
        if (this.refused.has(key) && report.event !== "start") return;
        if (report.event === "start") this.clearRefusal(key);
        if (this.live.size >= this.maxSessions) this.evictOldest();
        const created: LivePlayback = {
          key,
          actorId: authority.actor.id,
          libraryId,
          itemId,
          mediaSourceId: report.mediaSourceId,
          playSessionId: this.newSessionId(),
          position: report.position,
          paused: report.paused,
          lastSeen: this.clock(),
        };
        this.live.set(key, created);
        await this.send(created, authority, "playing");
        return;
      }

      const wasPaused = current.paused;
      current.position = report.position;
      current.paused = report.paused;
      current.lastSeen = this.clock();
      if (report.event === "start") {
        await this.send(current, authority, "playing");
        return;
      }
      const eventName = report.paused && !wasPaused ? "Pause" : !report.paused && wasPaused ? "Unpause" : "TimeUpdate";
      await this.send(current, authority, "progress", eventName);
    } catch (error) {
      log("DEBUG", "Media-server playback report failed", {
        kind: report.event === "stop" ? "stopped" : report.event === "start" ? "playing" : "progress",
        code: isMediaServerError(error) ? error.code : undefined,
      });
    }
  }

  async sweep(): Promise<void> {
    if (this.closed) return;
    const now = this.clock();
    const idle = [...this.live.values()].filter((entry) => now - entry.lastSeen >= this.idleMs);
    await Promise.all(idle.map((entry) => this.stopIdle(entry)));
  }

  start(): void {
    if (this.closed || this.timer) return;
    this.timer = setInterval(() => { void this.sweep(); }, this.sweepMs);
    this.timer.unref?.();
  }

  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    const stops = [...this.live.values()].map((entry) => this.stopIdle(entry));
    let deadline: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<void>((resolve) => {
      deadline = setTimeout(resolve, 3_000);
      deadline.unref?.();
    });
    this.closing = Promise.race([Promise.allSettled(stops).then(() => undefined), timeout])
      .finally(() => { if (deadline) clearTimeout(deadline); });
    return this.closing;
  }

  private async send(
    entry: LivePlayback,
    authority: MediaServerAuthority,
    kind: ProviderPlaybackReport["kind"],
    eventName?: ProviderPlaybackReport["eventName"],
  ): Promise<void> {
    const work = async () => {
      if (kind !== "stopped" && this.live.get(entry.key) !== entry) return;
      const report: ProviderPlaybackReport = {
        kind,
        mediaSourceId: entry.mediaSourceId,
        playSessionId: entry.providerPlaySessionId ?? entry.playSessionId,
        positionTicks: Math.round(entry.position * TICKS_PER_SECOND),
        isPaused: entry.paused,
        ...(kind === "progress" && eventName !== undefined ? { eventName } : {}),
      };
      try {
        const providerPlaySessionId = await this.manager.reportPlayback(authority, entry.libraryId, entry.itemId, report);
        if (kind === "playing" && providerPlaySessionId !== undefined && this.live.get(entry.key) === entry) {
          entry.providerPlaySessionId = providerPlaySessionId;
        }
        if (kind === "playing") this.clearRefusal(entry.key);
      } catch (error) {
        if (kind === "playing" && this.live.get(entry.key) === entry) {
          this.live.delete(entry.key);
          if (isMediaServerError(error) && PLAYBACK_REFUSAL_CODES.has(error.code)) this.rememberRefusal(entry.key);
        }
        log("DEBUG", "Media-server playback report failed", {
          kind,
          code: isMediaServerError(error) ? error.code : undefined,
        });
      }
    };
    const previous = this.tails.get(entry.key) ?? Promise.resolve();
    const next = previous.then(work);
    this.tails.set(entry.key, next);
    void next.then(() => {
      if (this.tails.get(entry.key) === next) this.tails.delete(entry.key);
    });
    await next;
  }

  private async stopIdle(entry: LivePlayback): Promise<void> {
    if (this.live.get(entry.key) !== entry) return;
    this.live.delete(entry.key);
    const authority = this.authorityFor(entry.actorId);
    if (authority) await this.send(entry, authority, "stopped");
  }

  private evictOldest(): void {
    let oldest: LivePlayback | undefined;
    for (const entry of this.live.values()) {
      if (!oldest || entry.lastSeen < oldest.lastSeen) oldest = entry;
    }
    if (oldest) void this.stopIdle(oldest);
  }

  private rememberRefusal(key: string): void {
    this.refused.delete(key);
    this.refused.set(key, true);
    while (this.refused.size > this.maxSessions) {
      const oldest = this.refused.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.refused.delete(oldest);
    }
  }

  private clearRefusal(key: string): void {
    this.refused.delete(key);
  }
}
