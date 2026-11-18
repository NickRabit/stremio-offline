import { isPathWithin } from "./library.js";

/** Library keys a request is changing on disk right now without going through the operations
 *  queue -- the rename route. The queue's own items are guarded by `libraryPathBusy`; this is
 *  the same guard for work that finishes inside one request, so a second request on the same
 *  item, or on anything inside or around it, is refused until the first one has moved the
 *  bindings too. */
export class PathReservations {
  private readonly held = new Set<{ keys: string[]; folded: string[] }>();

  /** Holds every key, or none of them when one overlaps a key already held. Synchronous on
   *  purpose: the check and the hold cannot be split by an `await`, so two requests can never
   *  both pass. Folded for the comparison, which only ever refuses more: a case-sensitive
   *  volume loses nothing but a concurrent rename of two names that differ in case. */
  reserve(keys: string[]): (() => void) | undefined {
    const folded = keys.map((key) => key.toLowerCase());
    for (const entry of this.held) {
      for (const held of entry.folded) {
        if (folded.some((key) => isPathWithin(key, held) || isPathWithin(held, key))) return undefined;
      }
    }
    const entry = { keys: [...keys], folded };
    this.held.add(entry);
    return () => { this.held.delete(entry); };
  }

  /** Every key held right now, as it was spelled. */
  keys(): string[] {
    return [...this.held].flatMap((entry) => entry.keys);
  }
}
