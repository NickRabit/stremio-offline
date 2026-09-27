/**
 * A value that is expensive to compute -- a walk of every library -- held for a while.
 *
 * Callers asking at the same moment share one computation instead of each walking the tree.
 * A caller that only renders a view may take a value past its age while a fresh one is
 * computed behind it: a network mount gives no change events, so the age is the only thing
 * that expires the walk, and making the page wait for it every half minute is what made the
 * library slow to open. A caller that acts on the answer asks for a current one.
 *
 * `invalidate` means the value is known to be wrong: nobody is served it again, and a
 * computation already running when it was called is not kept either.
 */
export class WalkCache<T> {
  private value: { at: number; data: T } | undefined;
  private running: { generation: number; promise: Promise<T> } | undefined;
  private generation = 0;

  constructor(
    private readonly compute: () => Promise<T>,
    private readonly ttlMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  get({ stale = false }: { stale?: boolean } = {}): Promise<T> {
    const held = this.value;
    if (held && this.now() - held.at < this.ttlMs) return Promise.resolve(held.data);
    if (held && stale) {
      this.refresh().catch(() => undefined);
      return Promise.resolve(held.data);
    }
    return this.refresh();
  }

  invalidate(): void {
    this.generation += 1;
    this.value = undefined;
  }

  private refresh(): Promise<T> {
    if (this.running?.generation === this.generation) return this.running.promise;
    const generation = this.generation;
    const promise = this.compute().then((data) => {
      if (generation === this.generation) this.value = { at: this.now(), data };
      return data;
    }).finally(() => {
      if (this.running?.promise === promise) this.running = undefined;
    });
    this.running = { generation, promise };
    return promise;
  }
}
