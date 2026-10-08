import type { PlaybackMode } from "./types";

/** Shared hls.js options. Remux can run faster than realtime, so a long
 *  forward buffer fills MSE and surfaces bufferFullError. */
export const HLS_PLAYER_CONFIG = {
  maxBufferLength: 25,
  maxMaxBufferLength: 45,
  backBufferLength: 60,
  maxBufferHole: 1,
  maxBufferSize: 40 * 1000 * 1000,
  liveDurationInfinity: true,
  liveSyncDurationCount: 3,
  startOnSegmentBoundary: true,
  maxLiveSyncPlaybackRate: 1,
  testBandwidth: false,
};

/** Letting go of a stream means letting go of the element too. What hls.js leaves behind is a
 *  MediaSource in its ended state, and the next stream appends into that one and gets nowhere:
 *  "SourceBuffer error. MediaSource readyState: ended", over and over, with no picture. */
export function releaseMediaElement(video: { pause(): void; removeAttribute(name: string): void; load(): void } | null) {
  if (!video) return;
  try { video.pause(); } catch { /* an element that never started */ }
  video.removeAttribute("src");
  try { video.load(); } catch { /* clearing a failed source */ }
}

/** 404s on a generation being replaced are expected. Do not fail the session. */
export const ignoreHlsErrorDuringRestart = (restarting: boolean) => restarting;

type StartStallVideo = Pick<HTMLVideoElement, "currentTime" | "paused" | "seeking" | "ended" | "buffered">;

function remuxStartNudgeTarget(video: StartStallVideo): number | undefined {
  if (video.paused || video.seeking || video.ended || !video.buffered.length) return;
  const start = video.buffered.start(0);
  const at = video.currentTime;
  if (start > 0.25 || at < start || at > start + 0.05 || video.buffered.end(0) - at < 2) return;
  return at + 0.1;
}

/** Safari can stop at the first buffered frame after remux seeking, with no hole for hls.js to skip. */
export function scheduleRemuxStartNudge(video: StartStallVideo, isCurrent: () => boolean, onNudge: () => void) {
  if (remuxStartNudgeTarget(video) === undefined) return;
  const stalledAt = video.currentTime;
  const timer = setTimeout(() => {
    if (!isCurrent() || Math.abs(video.currentTime - stalledAt) > 0.001) return;
    const target = remuxStartNudgeTarget(video);
    if (target === undefined) return;
    video.currentTime = target;
    onNudge();
  }, 1500);
  return () => clearTimeout(timer);
}

/** How far past the current playlist we wait for FFmpeg instead of restarting. */
export const AHEAD_CATCHUP_S = 20;
export const AHEAD_CATCHUP_MS = 8_000;

export type SeekPlan = "native" | "wait" | "restart";

/** Arrow-key skips should not kill FFmpeg: it is already remuxing toward that point. */
export function planSeek(relative: number, playlistEnd: number, aheadSeconds = AHEAD_CATCHUP_S): SeekPlan {
  if (relative < 0) return "restart";
  if (relative <= Math.max(0, playlistEnd - 0.5)) return "native";
  if (relative <= playlistEnd + aheadSeconds) return "wait";
  return "restart";
}

export async function waitForSeekable(
  playlistEnd: () => number,
  relative: number,
  timeoutMs: number,
  cancelled: () => boolean,
  now: () => number = Date.now,
  delay: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
): Promise<boolean> {
  const deadline = now() + timeoutMs;
  while (now() < deadline) {
    if (cancelled()) return false;
    if (relative <= Math.max(0, playlistEnd() - 0.5)) return true;
    await delay(100);
  }
  return relative <= Math.max(0, playlistEnd() - 0.5);
}

export const DECODE_RECOVER_LIMIT = 2;
export const DECODE_RECOVER_WINDOW_MS = 60_000;

/** Chrome/VideoToolbox sometimes rejects a copied HEVC access unit after a remux seek. */
export function canRecoverDecode(stamps: number[], now = Date.now()) {
  return stamps.filter((at) => now - at < DECODE_RECOVER_WINDOW_MS).length < DECODE_RECOVER_LIMIT;
}

export function recordDecodeRecover(stamps: number[], now = Date.now()) {
  return [...stamps.filter((at) => now - at < DECODE_RECOVER_WINDOW_MS), now];
}

export type DecodeAction = "escalate" | "restart" | "give-up";

/** What to do about a decoder failure. Repeating the same conversion is pointless: the
 *  server would spawn an identical FFmpeg and the browser would refuse it again, over and
 *  over until the window is closed. The video copy is the first thing to drop; after that
 *  there is nothing left to try. */
export function planDecodeRecovery(mode: PlaybackMode, stamps: number[], now = Date.now()): DecodeAction {
  if (!canRecoverDecode(stamps, now)) return "give-up";
  return mode === "transcode" ? "restart" : "escalate";
}
