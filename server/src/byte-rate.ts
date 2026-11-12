/** Offered caps in Mbit/s. `0` means no limit. */
export const DOWNLOAD_SPEED_LIMITS = [0, 5, 10, 20, 50, 100, 200, 500] as const;

/** 1 Mbit/s in bytes per second. */
export const BYTES_PER_MBIT = 125_000;

const MIN_CAPACITY = 64 * 1024;

const abortableSleep = (ms: number, signal: AbortSignal): Promise<void> => new Promise((resolve, reject) => {
  if (signal.aborted) {
    reject(signal.reason);
    return;
  }
  const onAbort = () => {
    globalThis.clearTimeout(timer);
    reject(signal.reason);
  };
  const timer = globalThis.setTimeout(() => {
    signal.removeEventListener("abort", onAbort);
    resolve();
  }, ms);
  signal.addEventListener("abort", onAbort, { once: true });
});

/**
 * One token bucket shared by every transfer. `take` spends `bytes` immediately
 * and, when that overdraws the bucket, waits until the debt is paid at the
 * current rate. The rate is read on every take, so a settings change is live.
 */
export class ByteRateLimiter {
  private balance = 0;
  private updatedAt = 0;
  /** False after an unlimited take, so the next limited take starts from a full bucket. */
  private limited = false;
  private tail: Promise<void> = Promise.resolve();

  constructor(
    private readonly rate: () => number,
    private readonly now: () => number = () => performance.now(),
    private readonly sleep: (ms: number, signal: AbortSignal) => Promise<void> = abortableSleep,
  ) {}

  take(bytes: number, signal: AbortSignal): Promise<void> {
    if (signal.aborted) return Promise.reject(signal.reason);
    if (!(this.rate() > 0)) {
      this.limited = false;
      return Promise.resolve();
    }
    if (!(bytes > 0)) return Promise.resolve();
    const run = this.tail.then(() => this.consume(bytes, signal));
    this.tail = run.then(() => undefined, () => undefined);
    return run;
  }

  private async consume(bytes: number, signal: AbortSignal): Promise<void> {
    if (signal.aborted) throw signal.reason;
    const rate = this.rate();
    if (!(rate > 0)) {
      this.limited = false;
      return;
    }
    const now = this.now();
    const capacity = Math.max(rate, MIN_CAPACITY);
    if (!this.limited) {
      this.balance = capacity;
      this.limited = true;
    } else {
      const elapsed = Math.max(0, now - this.updatedAt) / 1000;
      this.balance = Math.min(capacity, this.balance + elapsed * rate);
    }
    this.updatedAt = now;
    this.balance -= bytes;
    if (!(this.balance < 0)) return;
    const waitMs = (-this.balance / rate) * 1000;
    try {
      await this.sleep(waitMs, signal);
    } catch (error) {
      const elapsed = Math.max(0, this.now() - this.updatedAt) / 1000;
      const restored = this.balance + bytes + elapsed * rate;
      const current = this.rate();
      if (current > 0) this.balance = Math.min(Math.max(current, MIN_CAPACITY), restored);
      else {
        this.balance = restored;
        this.limited = false;
      }
      this.updatedAt = this.now();
      throw error;
    }
    this.balance = 0;
    this.updatedAt = this.now();
  }
}
