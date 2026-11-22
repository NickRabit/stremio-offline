import { describe, expect, it, vi } from "vitest";
import { SIDECAR_POLL_MS, SIDECAR_REFRESH_LEAD_S, SIDECAR_REQUEST_MS, SIDECAR_SETTLED_POLL_MS, watchSidecar } from "./player-sidecar";

const answer = (ok: boolean, headers: Record<string, string> = {}) => ({
  ok, status: ok ? 204 : 404, body: null, headers: new Headers(ok ? headers : {}),
}) as unknown as Response;
const reading = (coverage: number) => answer(true, { "x-sidecar-complete": "0", "x-sidecar-coverage": String(coverage) });
const whole = answer(true, { "x-sidecar-complete": "1" });
const moved = (url: string) => new Response(JSON.stringify({ sidecarUrl: url }), { status: 410 }) as Response;
const noDelay = () => Promise.resolve();

describe("watchSidecar", () => {
  it("waits for the reader to produce something before attaching a track", async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(answer(false))
      .mockRejectedValueOnce(new Error("not there yet"))
      .mockResolvedValueOnce(whole);
    const states: unknown[] = [];
    await watchSidecar("/sidecar.vtt", new AbortController().signal, () => 0, (state) => states.push(state), fetcher, noDelay);
    expect(states).toEqual([{ complete: true, pass: 0, coverage: Infinity }]);
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it("reads the track again before the picture catches up with the cues", async () => {
    const answers = [reading(600), reading(900), reading(1500), whole];
    const playheads = [0, 100, 580, 580];
    let at = 0;
    let playhead = 0;
    const fetcher = vi.fn().mockImplementation(() => { playhead = playheads[at]; return Promise.resolve(answers[at++]); });
    const states: unknown[] = [];
    await watchSidecar("/sidecar.vtt", new AbortController().signal, () => playhead, (state) => states.push(state), fetcher, noDelay);
    // The second answer arrives while the picture is still far behind the cues, so nothing is remounted for it.
    expect(states).toEqual([
      { complete: false, pass: 0, coverage: 600 },
      { complete: false, pass: 1, coverage: 1500 },
      { complete: true, pass: 2, coverage: Infinity },
    ]);
    expect(600 - SIDECAR_REFRESH_LEAD_S).toBeLessThan(playheads[2]);
  });

  it("does not remount a short track on every poll while the reader catches up", async () => {
    const answers = [reading(10), reading(15), reading(25), reading(70), whole];
    const playheads = [0, 5, 9, 10, 10];
    let at = 0;
    let playhead = 0;
    const urls: string[] = [];
    const fetcher = vi.fn().mockImplementation((url: string) => {
      urls.push(url);
      playhead = playheads[at];
      return Promise.resolve(answers[at++]);
    });
    const states: unknown[] = [];
    const waits: number[] = [];
    await watchSidecar("/sidecar.vtt?revision=test", new AbortController().signal, () => playhead, (state) => states.push(state), fetcher, async (ms) => { waits.push(ms); });
    expect(states).toEqual([
      { complete: false, pass: 0, coverage: 10 },
      { complete: false, pass: 1, coverage: 70 },
      { complete: true, pass: 2, coverage: Infinity },
    ]);
    expect(urls).toContain("/sidecar.vtt?revision=test&position=10.000&probe=1");
    expect(urls.every((url) => url.includes("&probe=1") || url.includes("?probe=1"))).toBe(true);
    expect(waits).toEqual([SIDECAR_POLL_MS, SIDECAR_POLL_MS, SIDECAR_POLL_MS, SIDECAR_SETTLED_POLL_MS]);
  });

  it("does not remount the track when the reader has found nothing new", async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(reading(600))
      .mockResolvedValueOnce(reading(600))
      .mockResolvedValueOnce(whole);
    const states: unknown[] = [];
    await watchSidecar("/sidecar.vtt", new AbortController().signal, () => 10_000, (state) => states.push(state), fetcher, noDelay);
    expect(states).toEqual([
      { complete: false, pass: 0, coverage: 600 },
      { complete: true, pass: 1, coverage: Infinity },
    ]);
  });

  it("stops when the player closes or the session changes", async () => {
    const controller = new AbortController();
    const fetcher = vi.fn().mockImplementation(() => { controller.abort(); return Promise.resolve(whole); });
    const states: unknown[] = [];
    await watchSidecar("/sidecar.vtt", controller.signal, () => 0, (state) => states.push(state), fetcher, noDelay);
    expect(states).toEqual([]);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("keeps polling missing responses for ten seconds without asking for another revision", async () => {
    const controller = new AbortController();
    let calls = 0;
    let revision = 0;
    let waited = 0;
    const fetcher = vi.fn().mockImplementation(() => {
      calls += 1;
      if (calls === 41) controller.abort();
      return Promise.resolve(answer(false));
    });
    await watchSidecar(
      "/sidecar.vtt",
      controller.signal,
      () => 0,
      () => {},
      fetcher,
      async (ms) => { waited += ms; },
      () => { revision += 1; },
    );
    expect(calls).toBe(41);
    expect(waited).toBe(10_000);
    expect(revision).toBe(0);
  });

  it("adopts the current URL from a 410 response", async () => {
    const urls: string[] = [];
    const fetcher = vi.fn().mockResolvedValueOnce(moved("/sidecar.vtt?revision=current"));
    await watchSidecar(
      "/sidecar.vtt?revision=old",
      new AbortController().signal,
      () => 0,
      () => {},
      fetcher,
      noDelay,
      (url) => { urls.push(url); },
    );
    expect(urls).toEqual(["/sidecar.vtt?revision=current"]);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("keeps polling when the caller does not take a 410's revision, or the 410 carries no URL", async () => {
    const controller = new AbortController();
    let calls = 0;
    const fetcher = vi.fn().mockImplementation(async () => {
      calls += 1;
      if (calls === 1) return moved("/sidecar.vtt?revision=older");
      if (calls === 2) return new Response("{}", { status: 410 }) as Response;
      controller.abort();
      return new Response(null, { status: 404 }) as Response;
    });
    await watchSidecar(
      "/sidecar.vtt?revision=old",
      controller.signal,
      () => 0,
      () => {},
      fetcher,
      noDelay,
      () => false,
    );
    expect(calls).toBe(3);
  });

  it("times out a single request without AbortSignal.any, which older Safari lacks", async () => {
    vi.useFakeTimers();
    try {
      const any = vi.spyOn(AbortSignal, "any");
      const signals: AbortSignal[] = [];
      const fetcher = vi.fn().mockImplementation((_url: string, init?: RequestInit) => {
        signals.push(init!.signal!);
        return new Promise(() => {});
      });
      void watchSidecar("/sidecar.vtt", new AbortController().signal, () => 0, () => {}, fetcher as unknown as typeof fetch);
      await vi.advanceTimersByTimeAsync(SIDECAR_REQUEST_MS + 1);
      expect(signals[0].aborted).toBe(true);
      expect(any).not.toHaveBeenCalled();
    } finally { vi.useRealTimers(); }
  });

  it("leaves no pending request timer behind once the track is complete", async () => {
    vi.useFakeTimers();
    try {
      const fetcher = vi.fn().mockResolvedValue(whole);
      await watchSidecar("/sidecar.vtt", new AbortController().signal, () => 0, () => {}, fetcher);
      expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); }
  });
});
