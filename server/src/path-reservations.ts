import { parseLibraryPath, posixBase, posixJoin, resolveLibraryPath, type LibraryRecord } from "./libraries.js";
import { isPathWithin } from "./library.js";
import type { LibraryOp } from "./library-ops.js";

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
    if (this.overlaps(keys)) return undefined;
    const entry = { keys: [...keys], folded: keys.map((key) => key.toLowerCase()) };
    this.held.add(entry);
    return () => { this.held.delete(entry); };
  }

  /** Whether any of these keys overlaps a key held right now, either way round. The operations
   *  queue asks before it touches an item, so a job queued while a rename was in flight waits
   *  for the rename instead of running against a name that just moved. */
  overlaps(keys: string[]): boolean {
    const folded = keys.map((key) => key.toLowerCase());
    for (const entry of this.held) {
      for (const held of entry.folded) {
        if (folded.some((key) => isPathWithin(key, held) || isPathWithin(held, key))) return true;
      }
    }
    return false;
  }

  /** Every key held right now, as it was spelled. */
  keys(): string[] {
    return [...this.held].flatMap((entry) => entry.keys);
  }
}

/** What the operations queue's pause check answers for one item while requests hold names:
 *  `"queue"` (wait and look again) when a held name overlaps the item or the place it is going,
 *  and for a re-root when anything inside its library is held -- the whole tree is about to move.
 *  `keys` are the item's qualified key and, for a move or copy, its destination's. */
export function reservationPause(reservations: PathReservations, operation: LibraryOp, keys: string[]): "queue" | undefined {
  if (operation.op === "reroot") {
    return reservations.keys().some((key) => parseLibraryPath(key)?.libraryId === operation.libraryId) ? "queue" : undefined;
  }
  return reservations.overlaps(keys) ? "queue" : undefined;
}

/** Where a move or copy puts one item: its own name inside the destination folder, the path
 *  `transferLibraryItem` writes. Shared by the queue's busy list, its pause check and the direct
 *  move route, so all three name the same place. */
export const destinationOf = (target: string, item: string): string => posixJoin(target, posixBase(item));

/** The qualified keys one queued item is about to touch: the item, and for a move or copy the
 *  name it takes in the destination. A path that does not resolve contributes nothing; the
 *  job itself refuses it. */
export async function queuedItemKeys(libraries: LibraryRecord[], operation: LibraryOp, item: string): Promise<string[]> {
  const source = await resolveLibraryPath(libraries, item);
  if (!source) return [];
  if (operation.op !== "move" && operation.op !== "copy") return [source.key];
  const destination = await resolveLibraryPath(libraries, destinationOf(operation.target, source.relative));
  return destination ? [source.key, destination.key] : [source.key];
}
