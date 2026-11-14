export class ProfileAttempts {
  private failures = new Map<string, { count: number; until: number }>();
  private now: () => number;

  constructor(
    now: () => number = () => Date.now(),
    private freeAttempts = 5,
    private baseDelayMs = 30_000,
    private maxDelayMs = 15 * 60_000,
    private lockAfter = 10,
    private maxKeys = 5000,
  ) {
    this.now = now;
  }

  private prune() {
    while (this.failures.size > this.maxKeys) this.failures.delete(this.failures.keys().next().value!);
  }

  retryAfterMs(userId: string): number {
    this.prune();
    return Math.max(0, (this.failures.get(userId)?.until ?? 0) - this.now());
  }

  pinLocked(userId: string): boolean {
    this.prune();
    return (this.failures.get(userId)?.count ?? 0) >= this.lockAfter;
  }

  fail(userId: string) {
    this.prune();
    const entry = this.failures.get(userId) ?? { count: 0, until: 0 };
    entry.count += 1;
    const over = entry.count - this.freeAttempts;
    entry.until = over > 0
      ? this.now() + Math.min(this.maxDelayMs, this.baseDelayMs * 2 ** (over - 1))
      : 0;
    this.failures.set(userId, entry);
    this.prune();
  }

  succeed(userId: string) {
    this.failures.delete(userId);
  }
}

export const profileAttempts = new ProfileAttempts();
