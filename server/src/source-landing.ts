interface Landing {
  url: string;
  usedAt: number;
}

export class SourceLanding {
  private readonly landings = new Map<string, Landing>();

  constructor(
    private readonly ttlMs = 10 * 60_000,
    private readonly max = 512,
    private readonly now = () => Date.now(),
  ) {}

  /** The address the resource last landed on, if it is still fresh. */
  get(resource: string): string | undefined {
    const landing = this.landings.get(resource);
    if (!landing) return undefined;
    if (this.now() - landing.usedAt >= this.ttlMs) {
      this.landings.delete(resource);
      return undefined;
    }
    return landing.url;
  }

  /** Records a landing, or refreshes one that was just used. */
  put(resource: string, url: string): void {
    this.landings.delete(resource);
    this.landings.set(resource, { url, usedAt: this.now() });
    while (this.landings.size > this.max) {
      const oldest = this.landings.keys().next();
      if (oldest.done) break;
      this.landings.delete(oldest.value);
    }
  }

  forget(resource: string): void {
    this.landings.delete(resource);
  }
}
