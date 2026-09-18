/** Rejections repeat: a player whose session expired retries a segment several times a second,
 * and a scanner knocking on the API does the same. Writing every one of them down buries the
 * first -- the only one that says something new -- so a key reports once per window and the
 * next line carries how many it stood for. */
export class RepeatFilter {
  private seen = new Map<string, { until: number; suppressed: number }>();

  constructor(private now = Date.now, private windowMs = 60_000, private maxKeys = 200) {}

  /** A key is forgotten one window after its own expired, not at the moment it expires:
   *  the count of what was held back has to survive long enough to be reported. */
  private prune() {
    for (const [key, entry] of this.seen) if (entry.until + this.windowMs <= this.now()) this.seen.delete(key);
    while (this.seen.size > this.maxKeys) this.seen.delete(this.seen.keys().next().value!);
  }

  /** How many were held back since the last reported one, or undefined when this one stays quiet.
   *  Both branches reinsert the key: a Map keeps a key where it was first put even when the value
   *  is replaced, so without this the busiest key is the oldest one and an overflow throws it out
   *  first -- costing exactly the count it was keeping. Reinserting orders the map by last use,
   *  and the key that falls out is one nobody has asked about in a while. */
  record(key: string): { suppressed: number } | undefined {
    this.prune();
    const entry = this.seen.get(key);
    this.seen.delete(key);
    if (entry && entry.until > this.now()) { entry.suppressed += 1; this.seen.set(key, entry); return undefined; }
    this.seen.set(key, { until: this.now() + this.windowMs, suppressed: 0 });
    return { suppressed: entry?.suppressed ?? 0 };
  }
}
