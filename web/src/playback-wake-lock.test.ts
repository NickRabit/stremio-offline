import { describe, expect, it, vi } from "vitest";
import { PlaybackWakeLock, screenWakeLock, type ScreenWakeLockSource, type WakeLockHandle } from "./playback-wake-lock";

/** jsdom hands out no wake lock, so the test brings its own sentinel and can drop it by hand. */
const makeSentinel = () => {
  const listeners = new Set<() => void>();
  let released = false;
  const release = vi.fn(async () => { if (released) return; released = true; fire(); });
  const fire = () => { for (const listener of [...listeners]) listener(); };
  const handle: WakeLockHandle = {
    get released() { return released; },
    release,
    addEventListener: (_type, listener) => { listeners.add(listener); },
    removeEventListener: (_type, listener) => { listeners.delete(listener); },
  };
  /** The browser releasing the lock by itself, with no `release()` call from here. */
  const drop = () => { released = true; fire(); };
  return { handle, release, drop };
};

const fakeSource = () => {
  const sentinels: ReturnType<typeof makeSentinel>[] = [];
  const wakeLock: ScreenWakeLockSource = {
    request: vi.fn(async () => {
      const sentinel = makeSentinel();
      sentinels.push(sentinel);
      return sentinel.handle;
    }),
  };
  return { wakeLock, sentinels };
};

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe("screenWakeLock", () => {
  it("is null where the API is absent", () => {
    expect(screenWakeLock({})).toBeNull();
    expect(screenWakeLock({ wakeLock: null })).toBeNull();
  });

  it("hands back the browser's own source without calling it", () => {
    const { wakeLock } = fakeSource();
    expect(screenWakeLock({ wakeLock })).toBe(wakeLock);
  });

  it("stays inert without a source", async () => {
    const lock = new PlaybackWakeLock(null, () => true);
    expect(() => lock.update(true)).not.toThrow();
    await flush();
    expect(lock.held).toBe(false);
  });
});

describe("PlaybackWakeLock", () => {
  it("holds one sentinel while visible and asks for nothing more", async () => {
    const { wakeLock, sentinels } = fakeSource();
    const lock = new PlaybackWakeLock(wakeLock, () => true);
    lock.update(true);
    await flush();
    expect(wakeLock.request).toHaveBeenCalledTimes(1);
    expect(wakeLock.request).toHaveBeenCalledWith("screen");
    expect(lock.held).toBe(true);
    lock.update(true);
    await flush();
    expect(wakeLock.request).toHaveBeenCalledTimes(1);
    expect(sentinels).toHaveLength(1);
  });

  it("releases on a pause and ignores one it already released", async () => {
    const { wakeLock, sentinels } = fakeSource();
    const lock = new PlaybackWakeLock(wakeLock, () => true);
    lock.update(true);
    await flush();
    lock.update(false);
    await flush();
    expect(sentinels[0].release).toHaveBeenCalledOnce();
    expect(lock.held).toBe(false);
    lock.update(false);
    await flush();
    expect(sentinels[0].release).toHaveBeenCalledOnce();
  });

  it("never asks while the document is hidden", async () => {
    const { wakeLock, sentinels } = fakeSource();
    let visible = false;
    const lock = new PlaybackWakeLock(wakeLock, () => visible);
    lock.update(true);
    await flush();
    expect(wakeLock.request).not.toHaveBeenCalled();
    visible = true;
    lock.update(true);
    await flush();
    expect(wakeLock.request).toHaveBeenCalledOnce();
    expect(sentinels).toHaveLength(1);
    expect(lock.held).toBe(true);
  });

  it("shrugs off a refused request", async () => {
    const wakeLock: ScreenWakeLockSource = { request: vi.fn(async () => { throw new Error("denied"); }) };
    const lock = new PlaybackWakeLock(wakeLock, () => true);
    expect(() => lock.update(true)).not.toThrow();
    await flush();
    expect(lock.held).toBe(false);
  });

  it("drops a sentinel the viewer no longer wants by the time it arrives", async () => {
    const { wakeLock, sentinels } = fakeSource();
    const lock = new PlaybackWakeLock(wakeLock, () => true);
    lock.update(true);
    lock.update(false);
    await flush();
    expect(sentinels[0].release).toHaveBeenCalledOnce();
    expect(lock.held).toBe(false);
  });

  it("asks again after the browser drops the lock, but not when the release was its own", async () => {
    const { wakeLock, sentinels } = fakeSource();
    const lock = new PlaybackWakeLock(wakeLock, () => true);
    lock.update(true);
    await flush();
    sentinels[0].drop();
    await flush();
    expect(wakeLock.request).toHaveBeenCalledTimes(2);
    expect(lock.held).toBe(true);
    lock.update(false);
    await flush();
    expect(wakeLock.request).toHaveBeenCalledTimes(2);
    expect(lock.held).toBe(false);
  });

  it("forgets the intent on release", async () => {
    const { wakeLock, sentinels } = fakeSource();
    let visible = true;
    const lock = new PlaybackWakeLock(wakeLock, () => visible);
    lock.update(true);
    await flush();
    visible = false;
    await lock.release();
    visible = true;
    lock.update(true);
    await flush();
    expect(sentinels[0].release).toHaveBeenCalledOnce();
    expect(wakeLock.request).toHaveBeenCalledTimes(2);
    expect(lock.held).toBe(true);
  });
});
