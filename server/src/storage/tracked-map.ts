export type TrackedSnapshot<K> = ReadonlyMap<K, number>;

export class TrackedMap<K, V> extends Map<K, V> {
  private readonly generations = new Map<K, number>();
  private nextGeneration = 0;

  override set(key: K, value: V): this {
    super.set(key, value);
    this.touch(key);
    return this;
  }

  override delete(key: K): boolean {
    const deleted = super.delete(key);
    this.touch(key);
    return deleted;
  }

  override clear(): void {
    for (const key of this.keys()) this.touch(key);
    super.clear();
  }

  snapshot(): TrackedSnapshot<K> {
    return new Map(this.generations);
  }

  forget(snapshot: TrackedSnapshot<K>): void {
    for (const [key, generation] of snapshot) {
      if (this.generations.get(key) === generation) this.generations.delete(key);
    }
  }

  hasDirty(): boolean {
    return this.generations.size > 0;
  }

  private touch(key: K): void {
    this.nextGeneration += 1;
    this.generations.set(key, this.nextGeneration);
  }
}
