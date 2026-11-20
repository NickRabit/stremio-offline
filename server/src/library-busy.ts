import { placed, realTarget, resolveLibraryPath, type LibraryRecord, type PlacedPath } from "./libraries.js";
import { heldOverlap } from "./path-reservations.js";

/** What the busy check reads. Functions rather than objects: the queue and the rename journal
 *  are built after the routes that ask, and are only read when a request does. */
export interface LibraryBusyDeps {
  libraries(): LibraryRecord[];
  caseInsensitive(library: LibraryRecord): boolean;
  /** Items of queued jobs that have not finished, as the requests spelled them. */
  queuedItems(): string[];
  /** The two roots of each re-root that has not finished, as absolute folders. */
  rerootRoots(): string[];
  /** Keys requests are working on right now. */
  heldKeys(): string[];
  renames: {
    hasUnreadableRecord(): boolean;
    busyKeys(): string[];
    conflicts(keys: readonly string[]): boolean;
  };
}

/** The active items and re-root roots resolved once, so every key a caller asks about is
 *  compared against the same snapshot instead of resolving the whole queue again per key. */
async function activeSnapshot(deps: LibraryBusyDeps, options: { ignoreReservations?: boolean }) {
  // The rename itself asks with its own names already held, so it only wants the queue and
  // the rename journal.
  const items = [...deps.queuedItems(), ...(options.ignoreReservations ? [] : deps.heldKeys()), ...deps.renames.busyKeys()];
  // A re-root's two roots are absolute folders, not keys: the one it writes into may sit inside
  // another library, and a request there would act under the move.
  const roots = deps.rerootRoots();
  if (!items.length && !roots.length) return undefined;
  const libraries = deps.libraries();
  const active = (await Promise.all(items.map(async (item) => {
    const resolved = await resolveLibraryPath(libraries, item);
    return { item, resolved: resolved && await placed(resolved) };
  }))).filter((entry): entry is { item: string; resolved: PlacedPath } => entry.resolved !== undefined);
  const rootPlaces = await Promise.all(roots.map((root) => realTarget(root)));
  return { libraries, active, roots, rootPlaces };
}

type ActiveSnapshot = NonNullable<Awaited<ReturnType<typeof activeSnapshot>>>;

/** The active item or re-root root that covers `key`, or `undefined`. */
async function coveringOf(deps: LibraryBusyDeps, snapshot: ActiveSnapshot, key: string): Promise<string | undefined> {
  const found = await resolveLibraryPath(snapshot.libraries, key);
  if (!found) return undefined;
  if (deps.renames.conflicts([found.key])) return found.key;
  const wanted = await placed(found);
  // Compared where they are on disk, links resolved: the same file through a nested library
  // or a root typed through a symlink is one place. On a volume that folds case, `archive`
  // is the folder `Archive`: compared as the volume reads them, or a rename of a destination
  // folder spelled in another case would pass.
  const covering = snapshot.active.find(({ resolved }) => heldOverlap(resolved, wanted,
    deps.caseInsensitive(resolved.library) || deps.caseInsensitive(wanted.library)));
  if (covering) return covering.item;
  const root = snapshot.rootPlaces.findIndex((place) => heldOverlap({ place }, wanted, deps.caseInsensitive(wanted.library)));
  return root >= 0 ? snapshot.roots[root] : undefined;
}

/** The busy check every direct library request asks before it touches the disk: the active
 *  item that covers one of `keys`, or `undefined`. Containment counts both ways -- a job on a
 *  folder blocks the file inside it, and a job on a file blocks the folder that holds it. A
 *  `reroot` job names its library instead of an item, and that library's root is the parent of
 *  every key in it, so one comparison covers that case too.
 *
 *  The whole request is asked at once because resolving a key walks the filesystem for its
 *  real ancestor: a 500-item operation checked against a 500-item job one key at a time would
 *  be a quarter of a million of those walks before anything is queued. */
export function createLibraryPathBusy(deps: LibraryBusyDeps) {
  return async (keys: string[], options: { ignoreReservations?: boolean } = {}): Promise<string | undefined> => {
    // A rename finishes inside its request and never enters the queue; it holds its names here.
    if (deps.renames.hasUnreadableRecord()) return "rename";
    const snapshot = await activeSnapshot(deps, options);
    if (!snapshot) return undefined;
    for (const key of keys) {
      const covering = await coveringOf(deps, snapshot, key);
      if (covering) return covering;
    }
    return undefined;
  };
}

/** Which of `keys` are busy, each judged as `createLibraryPathBusy` would judge it alone, with
 *  the queue resolved once for all of them: a plan over every title of a library asks about
 *  hundreds of keys while a large job may hold hundreds of items. */
export function createLibraryPathsBusy(deps: LibraryBusyDeps) {
  return async (keys: string[]): Promise<Set<string>> => {
    if (deps.renames.hasUnreadableRecord()) return new Set(keys);
    const snapshot = await activeSnapshot(deps, {});
    if (!snapshot) return new Set();
    const busy = new Set<string>();
    for (const key of keys) if (await coveringOf(deps, snapshot, key)) busy.add(key);
    return busy;
  };
}

/** Whether anything is writing to a library: the queue's item under way, or a direct rename,
 *  move, delete or new folder holding its paths. A scan or a thumbnail sweep that read the tree
 *  meanwhile could take a file the work is still carrying -- or its poster -- for gone. */
export const libraryWriting = (queueWriting: boolean, heldKeys: readonly string[]): boolean =>
  queueWriting || heldKeys.length > 0;
