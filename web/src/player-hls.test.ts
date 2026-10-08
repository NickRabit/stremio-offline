import { afterEach, describe, expect, it, vi } from "vitest";
import { releaseMediaElement, HLS_PLAYER_CONFIG, canRecoverDecode, ignoreHlsErrorDuringRestart, planDecodeRecovery, planSeek, recordDecodeRecover, scheduleRemuxStartNudge, waitForSeekable } from "./player-hls";

describe("HLS_PLAYER_CONFIG", () => {
  it("keeps the forward buffer short enough that an 8x remux burst should not fill MSE", () => {
    expect(HLS_PLAYER_CONFIG.maxBufferLength).toBeLessThanOrEqual(30);
    expect(HLS_PLAYER_CONFIG.maxMaxBufferLength).toBeLessThanOrEqual(60);
    expect(HLS_PLAYER_CONFIG.maxBufferSize).toBeLessThanOrEqual(60 * 1000 * 1000);
  });

  it("keeps enough of a growing EVENT playlist behind its edge to survive startup", () => {
    expect(HLS_PLAYER_CONFIG.liveDurationInfinity).toBe(true);
    expect(HLS_PLAYER_CONFIG.liveSyncDurationCount).toBeGreaterThanOrEqual(3);
    expect(HLS_PLAYER_CONFIG.startOnSegmentBoundary).toBe(true);
    expect(HLS_PLAYER_CONFIG.testBandwidth).toBe(false);
  });
});

describe("ignoreHlsErrorDuringRestart", () => {
  it("swallows errors only while a seek or track switch is replacing the playlist", () => {
    expect(ignoreHlsErrorDuringRestart(true)).toBe(true);
    expect(ignoreHlsErrorDuringRestart(false)).toBe(false);
  });
});

describe("planSeek", () => {
  it("uses the current playlist for skips already converted", () => {
    expect(planSeek(5, 12)).toBe("native");
    expect(planSeek(11.4, 12)).toBe("native");
  });

  it("waits for FFmpeg on a short skip just ahead of the playlist", () => {
    expect(planSeek(10, 2)).toBe("wait");
    expect(planSeek(21.5, 2)).toBe("wait");
  });

  it("restarts conversion for a jump backward or far ahead", () => {
    expect(planSeek(-1, 12)).toBe("restart");
    expect(planSeek(40, 2)).toBe("restart");
  });
});

describe("waitForSeekable", () => {
  it("resolves once the playlist covers the target", async () => {
    let end = 2;
    const ok = waitForSeekable(() => end, 10, 1000, () => false, Date.now, async () => { end = 12; });
    await expect(ok).resolves.toBe(true);
  });

  it("stops when a newer seek supersedes the wait", async () => {
    const ok = await waitForSeekable(() => 2, 10, 1000, () => true, Date.now, async () => undefined);
    expect(ok).toBe(false);
  });
});

describe("canRecoverDecode", () => {
  it("allows two restarts in a minute, then stops", () => {
    const t = 1_000_000;
    expect(canRecoverDecode([], t)).toBe(true);
    const once = recordDecodeRecover([], t);
    const twice = recordDecodeRecover(once, t + 1000);
    expect(canRecoverDecode(twice, t + 2000)).toBe(false);
    expect(canRecoverDecode(twice, t + 61_000)).toBe(true);
  });
});

describe("planDecodeRecovery", () => {
  const t = 1_000_000;

  it("escalates a copied stream the browser refused to a real transcode", () => {
    expect(planDecodeRecovery("remux", [], t)).toBe("escalate");
    expect(planDecodeRecovery("direct", [], t)).toBe("escalate");
  });

  it("only restarts when the server already transcodes: there is nothing left to drop", () => {
    expect(planDecodeRecovery("transcode", [], t)).toBe("restart");
  });

  it("gives up once the restarts are spent, so the player stops looping on the error", () => {
    const spent = recordDecodeRecover(recordDecodeRecover([], t), t + 1000);
    expect(planDecodeRecovery("remux", spent, t + 2000)).toBe("give-up");
    expect(planDecodeRecovery("transcode", spent, t + 2000)).toBe("give-up");
  });
});

describe("releaseMediaElement", () => {
  const element = () => {
    const calls: string[] = [];
    return { calls, video: {
      pause: () => { calls.push("pause"); },
      removeAttribute: (name: string) => { calls.push(`remove:${name}`); },
      load: () => { calls.push("load"); },
    } };
  };

  it("clears the element, so the next stream does not append into a MediaSource that has ended", () => {
    const { calls, video } = element();
    releaseMediaElement(video);
    expect(calls).toEqual(["pause", "remove:src", "load"]);
  });

  it("survives an element that will not do any of it", () => {
    const calls: string[] = [];
    expect(() => releaseMediaElement({
      pause: () => { throw new Error("never started"); },
      removeAttribute: (name: string) => { calls.push(name); },
      load: () => { throw new Error("nothing to load"); },
    })).not.toThrow();
    expect(calls).toEqual(["src"]);
    expect(() => releaseMediaElement(null)).not.toThrow();
  });
});


describe("scheduleRemuxStartNudge", () => {
  afterEach(() => vi.useRealTimers());
  const stalledVideo = () => ({ currentTime: 0.0666667, paused: false, seeking: false, ended: false,
    buffered: { length: 1, start: () => 0.0666666667, end: () => 12.0047 },
  });

  it("nudges the logged buffered-start stall once, after allowing normal recovery", () => {
    vi.useFakeTimers();
    const video = stalledVideo();
    const report = vi.fn();
    scheduleRemuxStartNudge(video, () => true, report);
    vi.advanceTimersByTime(1499);
    expect(video.currentTime).toBe(0.0666667);
    vi.advanceTimersByTime(1);
    expect(video.currentTime).toBeCloseTo(0.1666667);
    vi.advanceTimersByTime(10_000);
    expect(report).toHaveBeenCalledTimes(1);
  });

  it.each(["progress", "pause", "seeking", "ended", "replaced", "destroyed", "empty"])("does not interfere after %s", (change) => {
    vi.useFakeTimers();
    const video = stalledVideo();
    const report = vi.fn();
    let current = true;
    const cancel = scheduleRemuxStartNudge(video, () => current, report);
    if (change === "progress") video.currentTime += 0.03;
    if (change === "pause") video.paused = true;
    if (change === "seeking") video.seeking = true;
    if (change === "ended") video.ended = true;
    if (change === "replaced") current = false;
    if (change === "destroyed") cancel?.();
    if (change === "empty") video.buffered.length = 0;
    const at = video.currentTime;
    vi.advanceTimersByTime(2000);
    expect(video.currentTime).toBe(at);
    expect(report).not.toHaveBeenCalled();
  });

  it("leaves gaps, later stalls and insufficient buffer to the existing recovery", () => {
    vi.useFakeTimers();
    for (const at of [0, 0.2, 4]) {
      const video = { ...stalledVideo(), currentTime: at };
      expect(scheduleRemuxStartNudge(video, () => true, vi.fn())).toBeUndefined();
    }
    const video = stalledVideo();
    video.buffered.end = () => 1;
    expect(scheduleRemuxStartNudge(video, () => true, vi.fn())).toBeUndefined();
  });
});
