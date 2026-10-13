export interface WakeLockHandle {
  readonly released: boolean;
  release(): Promise<unknown>;
  addEventListener(type: "release", listener: () => void): void;
  removeEventListener(type: "release", listener: () => void): void;
}

export interface ScreenWakeLockSource {
  request(type: "screen"): Promise<WakeLockHandle>;
}

/** The Screen Wake Lock API is only present in a secure context, so a plain `http://` address
 *  hands back null and playback carries on without it. */
export function screenWakeLock(host: { wakeLock?: ScreenWakeLockSource | null }): ScreenWakeLockSource | null {
  return host.wakeLock ?? null;
}

/** Holds one screen wake lock while the viewer means to watch, and asks again after the browser
 *  drops it. `update` is called from the render effect and from `visibilitychange`. */
export class PlaybackWakeLock {
  private wanted = false;
  private handle: WakeLockHandle | null = null;
  private requesting = false;
  private readonly onRelease = () => {
    this.handle?.removeEventListener("release", this.onRelease);
    this.handle = null;
    if (this.wanted && this.isVisible()) void this.acquire();
  };

  constructor(private readonly source: ScreenWakeLockSource | null, private readonly isVisible: () => boolean) {}

  /** True only while a sentinel is held and not released. */
  get held(): boolean {
    return this.handle !== null && !this.handle.released;
  }

  /** `active` means the viewer means to watch. */
  update(active: boolean): void {
    this.wanted = active;
    if (!active) { void this.release(); return; }
    if (this.handle || this.requesting || !this.source || !this.isVisible()) return;
    void this.acquire();
  }

  async release(): Promise<void> {
    this.wanted = false;
    const handle = this.handle;
    this.handle = null;
    if (!handle || handle.released) return;
    handle.removeEventListener("release", this.onRelease);
    try { await handle.release(); } catch { /* the browser may have released it already */ }
  }

  private async acquire(): Promise<void> {
    const source = this.source;
    if (!source) return;
    this.requesting = true;
    let handle: WakeLockHandle;
    try {
      handle = await source.request("screen");
    } catch {
      return;
    } finally {
      this.requesting = false;
    }
    // The viewer paused, or the document went hidden, while the browser was answering.
    if (!this.wanted || !this.isVisible() || this.handle) {
      try { await handle.release(); } catch { /* already gone */ }
      return;
    }
    this.handle = handle;
    handle.addEventListener("release", this.onRelease);
  }
}
