import path from "node:path";
import { parseLibraryPath, posixBase, posixJoin, resolveLibraryPath, toPosix, type LibraryRecord, type ResolvedPath } from "./libraries.js";
import { isPathWithin } from "./library.js";
import type { LibraryOp } from "./library-ops.js";

/** One held path: the key a request named it by, and where it is on disk. */
export interface HeldPath {
  key: string;
  absolute: string;
}

/** Where a path is on disk, in the one spelling every comparison uses. A file inside a nested
 *  library has two keys -- one through its own library, one through the parent -- and both
 *  name the same place, so holds are compared by place, never by key. Folded, which only ever
 *  refuses more: a case-sensitive volume loses nothing but a concurrent rename of two names
 *  that differ in case, while a folding volume would otherwise let `archive` and `Archive`
 *  pass each other. */
const placeOf = (absolute: string): string => path.resolve(absolute).toLowerCase();

/** Whether two places on disk contain one another, either way round, compared the way their
 *  volume reads names: on a volume that folds case `archive` is the folder `Archive`. */
export const placesOverlap = (left: string, right: string, foldsCase: boolean): boolean => {
  const a = foldsCase ? left.toLowerCase() : left;
  const b = foldsCase ? right.toLowerCase() : right;
  return isPathWithin(a, b) || isPathWithin(b, a);
};

/** Library paths a request is changing on disk right now without going through the operations
 *  queue -- a rename, a delete, a direct move. The queue's own items are guarded by
 *  `libraryPathBusy`; this is the same guard for work that finishes inside one request, so a
 *  second request on the same item, or on anything inside or around it, is refused until the
 *  first one is done. */
export class PathReservations {
  private readonly held = new Set<{ keys: string[]; places: string[] }>();

  /** Holds every path, or none of them when one overlaps a path already held. Synchronous on
   *  purpose: the check and the hold cannot be split by an `await`, so two requests can never
   *  both pass. */
  reserve(paths: HeldPath[]): (() => void) | undefined {
    if (this.overlaps(paths)) return undefined;
    const entry = { keys: paths.map((held) => held.key), places: paths.map((held) => placeOf(held.absolute)) };
    this.held.add(entry);
    return () => { this.held.delete(entry); };
  }

  /** Whether any of these paths overlaps a held one, either way round. The operations queue
   *  asks before it touches an item, so a job queued while a request was in flight waits for
   *  it instead of running against a name that just moved. */
  overlaps(paths: Array<Pick<HeldPath, "absolute">>): boolean {
    const places = paths.map((held) => placeOf(held.absolute));
    for (const entry of this.held) {
      for (const held of entry.places) {
        if (places.some((place) => isPathWithin(place, held) || isPathWithin(held, place))) return true;
      }
    }
    return false;
  }

  /** Every key held right now, as it was spelled. */
  keys(): string[] {
    return [...this.held].flatMap((entry) => entry.keys);
  }
}

/** What the operations queue's pause check answers for one item while requests hold paths:
 *  `"queue"` (wait and look again) when a held path overlaps the item or the place it is going,
 *  and for a re-root when anything inside the root it moves is held -- the whole tree is about
 *  to move. `paths` are the item and, for a move or copy, its destination. */
export function reservationPause(reservations: PathReservations, operation: LibraryOp, paths: Array<Pick<HeldPath, "absolute">>): "queue" | undefined {
  if (operation.op === "reroot") return reservations.overlaps([{ absolute: operation.from }]) ? "queue" : undefined;
  return reservations.overlaps(paths) ? "queue" : undefined;
}

/** Where a move or copy puts one item: its own name inside the destination folder, the path
 *  `transferLibraryItem` writes. Shared by the queue's busy list, its pause check and the direct
 *  move route, so all three name the same place. */
export const destinationOf = (target: string, item: string): string => {
  // An unqualified item is read the way `resolveLibraryPath` reads it: on Windows a backslash
  // separates folders there, so `Films\Heat.mkv` goes to `Archive/Heat.mkv`, not to a file
  // named after the whole string. A qualified key keeps a backslash as an ordinary character.
  const spelled = parseLibraryPath(item) ? item : toPosix(item);
  // A trailing slash names the same folder. Trimmed by hand rather than with a regular
  // expression: the item comes from the request, and a long run of slashes must stay cheap.
  let end = spelled.length;
  while (end > 0 && spelled[end - 1] === "/") end -= 1;
  return posixJoin(target, posixBase(spelled.slice(0, end)));
};

/** The paths one queued item is about to touch: the item, and for a move or copy the name it
 *  takes in the destination. A path that does not resolve contributes nothing; the job itself
 *  refuses it. */
export async function queuedItemPaths(libraries: LibraryRecord[], operation: LibraryOp, item: string): Promise<ResolvedPath[]> {
  const source = await resolveLibraryPath(libraries, item);
  if (!source) return [];
  if (operation.op !== "move" && operation.op !== "copy") return [source];
  const destination = await resolveLibraryPath(libraries, destinationOf(operation.target, source.relative));
  return destination ? [source, destination] : [source];
}
