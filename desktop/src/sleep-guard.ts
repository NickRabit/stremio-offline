/** The slice of Electron's `powerSaveBlocker` the guard needs, so a test can stand one in. */
export interface SleepBlocker {
  start(type: "prevent-app-suspension"): number;
  stop(id: number): void;
}

/** One blocker at most, held while the local backend downloads, or is shared and something
 *  streams: a sleeping Mac would cut a download off from the network. */
export class SleepGuard {
  private id: number | null = null;

  constructor(private readonly blocker: SleepBlocker) {}

  get held(): boolean {
    return this.id !== null;
  }

  update(state: { published: boolean; streaming: boolean; downloading: boolean }): void {
    if (!state.downloading && !(state.published && state.streaming)) return this.release();
    if (this.id === null) this.id = this.blocker.start("prevent-app-suspension");
  }

  release(): void {
    if (this.id === null) return;
    this.blocker.stop(this.id);
    this.id = null;
  }
}
