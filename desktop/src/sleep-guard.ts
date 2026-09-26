/** The slice of Electron's `powerSaveBlocker` the guard needs, so a test can stand one in. */
export interface SleepBlocker {
  start(type: "prevent-app-suspension"): number;
  stop(id: number): void;
}

/** One blocker at most, held only while the local backend is shared and something streams. */
export class SleepGuard {
  private id: number | null = null;

  constructor(private readonly blocker: SleepBlocker) {}

  get held(): boolean {
    return this.id !== null;
  }

  update(state: { published: boolean; streaming: boolean }): void {
    if (!state.published || !state.streaming) return this.release();
    if (this.id === null) this.id = this.blocker.start("prevent-app-suspension");
  }

  release(): void {
    if (this.id === null) return;
    this.blocker.stop(this.id);
    this.id = null;
  }
}
