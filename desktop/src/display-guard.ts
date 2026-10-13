/** The slice of Electron's `powerSaveBlocker` the display guard needs, so a test can stand one in. */
export interface DisplayBlocker {
  start(type: "prevent-display-sleep"): number;
  stop(id: number): void;
}

/** One display blocker at most, held while the remote page plays media. `release` drops the
 *  OS assertion without pretending the playing elements were drained; `reset` clears both. */
export class DisplayGuard {
  private id: number | null = null;
  private playing = 0;

  constructor(private readonly blocker: DisplayBlocker) {}

  get held(): boolean {
    return this.id !== null;
  }

  started(): void {
    this.playing += 1;
    if (this.id === null) this.id = this.blocker.start("prevent-display-sleep");
  }

  paused(): void {
    if (this.playing === 0) return;
    this.playing -= 1;
    if (this.playing > 0) return;
    this.stop();
  }

  reset(): void {
    this.playing = 0;
    this.stop();
  }

  release(): void {
    this.stop();
  }

  private stop(): void {
    if (this.id === null) return;
    this.blocker.stop(this.id);
    this.id = null;
  }
}

export interface MediaEvents {
  on(event: "media-started-playing" | "media-paused" | "destroyed", listener: () => void): void;
  removeListener(event: "media-started-playing" | "media-paused" | "destroyed", listener: () => void): void;
}

/** Returns a detach that removes the listeners and then calls `guard.reset()`. A second call is a no-op. */
export function attachDisplayGuard(source: MediaEvents, guard: DisplayGuard): () => void {
  let attached = true;
  const started = () => guard.started();
  const paused = () => guard.paused();
  const detach = () => {
    if (!attached) return;
    attached = false;
    source.removeListener("media-started-playing", started);
    source.removeListener("media-paused", paused);
    source.removeListener("destroyed", detach);
    guard.reset();
  };
  source.on("media-started-playing", started);
  source.on("media-paused", paused);
  source.on("destroyed", detach);
  return detach;
}
