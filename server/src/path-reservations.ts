import path from "node:path";
import { parseLibraryPath, placed, posixBase, posixJoin, resolveLibraryPath, toPosix, type LibraryRecord, type PlacedPath } from "./libraries.js";
import { isPathWithin, isVideo } from "./library.js";
import { isSidecarOf } from "./library-sidecars.js";
import type { LibraryOp } from "./library-ops.js";

/** One held path: the key a request named it by, where it is on disk, and -- when it came from
 *  `placed` -- the same place with every symlink on the way resolved. */
export interface HeldPath {
  key: string;
  absolute: string;
  place?: string;
}

/** Where a path is on disk, in the one spelling every comparison uses. A file inside a nested
 *  library has two keys -- one through its own library, one through the parent -- and both
 *  name the same place, so holds are compared by place, never by key. The resolved place is
 *  preferred: a library root typed through a symlink reaches the same files under another
 *  spelling. Normalised to NFC because macOS volumes store one name for both forms. */
const placeOf = (held: Pick<HeldPath, "absolute" | "place">): string => (held.place ?? path.resolve(held.absolute)).normalize("NFC");

/** The video a subtitle beside it belongs to travels with it: a rename, move or delete of the
 *  video carries the subtitles under its stem, so either one held holds the other. */
const sidecarOf = (video: string, other: string): boolean => {
  const own = path.basename(video);
  if (!isVideo(own) || path.dirname(video) !== path.dirname(other)) return false;
  return isSidecarOf(path.basename(other), own.slice(0, own.length - path.extname(own).length));
};

/** Whether two places on disk contain one another, either way round, or are a video and one of
 *  its subtitles -- compared the way their volume reads names: on a volume that folds case
 *  `archive` is the folder `Archive`. */
export const placesOverlap = (left: string, right: string, foldsCase: boolean): boolean => {
  const fold = (value: string) => {
    const normal = value.normalize("NFC");
    return foldsCase ? normal.toLowerCase() : normal;
  };
  const a = fold(left);
  const b = fold(right);
  return isPathWithin(a, b) || isPathWithin(b, a) || sidecarOf(a, b) || sidecarOf(b, a);
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
    const entry = { keys: paths.map((held) => held.key), places: paths.map(placeOf) };
    this.held.add(entry);
    return () => { this.held.delete(entry); };
  }

  /** Whether any of these paths overlaps a held one, either way round. The operations queue
   *  asks before it touches an item, so a job queued while a request was in flight waits for
   *  it instead of running against a name that just moved. */
  overlaps(paths: Array<Pick<HeldPath, "absolute" | "place">>): boolean {
    // Folded, which only ever refuses more: a case-sensitive volume loses nothing but a
    // concurrent rename of two names that differ in case, while a folding volume would
    // otherwise let `archive` and `Archive` pass each other.
    const places = paths.map(placeOf);
    for (const entry of this.held) {
      for (const held of entry.places) {
        if (places.some((place) => placesOverlap(place, held, true))) return true;
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
 *  and for a re-root when anything inside the root it leaves or the folder it writes into is
 *  held -- the whole tree is about to move. `paths` are the item and, for a move or copy, its
 *  destination; for a re-root, its two roots with their links resolved. */
export function reservationPause(reservations: PathReservations, operation: LibraryOp, paths: Array<Pick<HeldPath, "absolute" | "place">>): "queue" | undefined {
  const touched = operation.op === "reroot" ? [{ absolute: operation.from }, { absolute: operation.to }, ...paths] : paths;
  return reservations.overlaps(touched) ? "queue" : undefined;
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
export async function queuedItemPaths(libraries: LibraryRecord[], operation: LibraryOp, item: string): Promise<PlacedPath[]> {
  const source = await resolveLibraryPath(libraries, item);
  if (!source) return [];
  if (operation.op !== "move" && operation.op !== "copy") return [await placed(source)];
  const destination = await resolveLibraryPath(libraries, destinationOf(operation.target, source.relative));
  return Promise.all((destination ? [source, destination] : [source]).map(placed));
}
