/** At most `slots` calls run at once; the rest wait in arrival order. A waiter whose signal
 *  aborts leaves the queue without ever running. */
export class SlotGate {
  private active = 0;
  private readonly waiting: Array<() => void> = [];

  constructor(private readonly slots: number) {}

  get running(): number { return this.active; }
  get queued(): number { return this.waiting.length; }

  async run<T>(work: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    await this.acquire(signal);
    try {
      return await work();
    } finally {
      this.release();
    }
  }

  private acquire(signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    if (this.active < this.slots) {
      this.active += 1;
      return Promise.resolve();
    }
    return new Promise<void>((resolve, reject) => {
      const grant = () => {
        signal?.removeEventListener("abort", onAbort);
        this.active += 1;
        resolve();
      };
      const onAbort = () => {
        const at = this.waiting.indexOf(grant);
        if (at >= 0) this.waiting.splice(at, 1);
        reject(signal!.reason);
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      this.waiting.push(grant);
    });
  }

  private release(): void {
    this.active -= 1;
    while (this.active < this.slots && this.waiting.length) this.waiting.shift()!();
  }
}
