import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import { buildLibrary, type CheckedWalk } from "./library.js";
import { libraryPath, parseLibraryPath } from "./libraries.js";
import { log } from "./logger.js";

export interface SweepLibrary { id: string; name: string; exclude: ReadonlySet<string>; root: string }
export interface SweepDeps {
  /** Enabled and reachable libraries only; runs the health refresh. */
  libraries(): Promise<SweepLibrary[]>;
  /** A fresh walk of the whole tree: production wires `listVideosChecked(root, exclude)`. */
  scan(library: SweepLibrary): Promise<CheckedWalk>;
  /** Qualified keys of queued downloads (`queuedArtworkKey`). */
  queuedKeys(): string[];
  /** Basenames of every `ART_VARIANTS` file of one key. */
  artNames(key: string): string[];
  directoryOf(libraryId: string): string;
  remove(file: string): Promise<void>;
  /** A library operation is writing or active. */
  busy(): boolean;
  /** Bumped by `invalidateLibrary()`. */
  epoch(): number;
  now(): number;
  signal: AbortSignal;
}

/** A thumbnail younger than this is kept whatever it is: its source may still be on its way. */
const FRESH_MS = 60 * 60_000;

/**
 * Thumbnails in the data directory outlive the video. One pass walks every configured
 * library, builds the set of pictures that are still valid and removes the rest. The
 * decision comes from a fresh, authoritative scan: a library that could not be read
 * completely is left alone, and one that looks empty is only cleaned when it was
 * authoritatively empty on the previous pass too -- an unmounted share often leaves a
 * reachable, empty mount point. Only `directoryOf` is ever read, so artwork beside the
 * media is never touched and a library that is gone but not forgotten keeps its directory.
 */
export function createArtworkSweep(deps: SweepDeps): () => Promise<{ removed: number }> {
  /** Libraries whose last pass was an authoritative, empty walk. */
  const emptySeen = new Set<string>();

  return async () => {
    if (deps.signal.aborted) { emptySeen.clear(); return { removed: 0 }; }
    const libraries = await deps.libraries();
    const present = new Set(libraries.map((library) => library.id));
    for (const id of [...emptySeen]) if (!present.has(id)) emptySeen.delete(id);
    const queued = deps.queuedKeys();
    let removed = 0;
    for (const library of libraries) {
      try {
        if (deps.signal.aborted) { emptySeen.clear(); return { removed }; }
        if (deps.busy()) {
          emptySeen.clear();
          log("DEBUG", "Thumbnail sweep postponed, a library operation is running");
          return { removed: 0 };
        }
        const epoch = deps.epoch();
        const walk = await deps.scan(library);
        if (deps.signal.aborted) { emptySeen.clear(); return { removed }; }
        if (!walk.complete) {
          emptySeen.delete(library.id);
          log("WARN", "The library could not be read completely, its thumbnails are left alone", { library: library.name });
          continue;
        }
        if (walk.files.length === 0) {
          // The first empty answer only records the suspicion: a share that is not mounted
          // still answers, and an empty listing is not a library with nothing in it.
          if (!emptySeen.has(library.id)) {
            emptySeen.add(library.id);
            log("DEBUG", "The library looks empty, thumbnails kept until the next pass", { library: library.name });
            continue;
          }
        } else emptySeen.delete(library.id);

        const valid = new Set<string>();
        const rememberArt = (key: string) => { for (const name of deps.artNames(key)) valid.add(name); };
        // The ancestor rows matter: a folder is keyed `dir:<path>` for paths that appear in
        // no file and in no binding, because a folder is not a file.
        const remember = (key: string) => {
          rememberArt(key);
          const parts = key.split("/");
          for (let depth = 1; depth < parts.length; depth += 1) rememberArt(`dir:${parts.slice(0, depth).join("/")}`);
        };
        for (const entry of buildLibrary(walk.files)) {
          rememberArt(libraryPath(library.id, entry.key));
          for (const file of entry.files) remember(libraryPath(library.id, file.path));
        }
        for (const key of queued) if (parseLibraryPath(key)?.libraryId === library.id) remember(key);

        const dir = deps.directoryOf(library.id);
        let halted = false;
        for (const name of await readdir(dir).catch(() => [] as string[])) {
          if (valid.has(name)) continue;
          if (deps.signal.aborted) { emptySeen.clear(); return { removed }; }
          // A mutation (move, rename, delete, download completion, watcher event, reroot)
          // bumps the epoch, so a set that predates it must not be acted on.
          if (deps.epoch() !== epoch || deps.busy()) {
            if (!halted) { log("DEBUG", "Thumbnail sweep stopped, the library changed under it", { library: library.name }); halted = true; }
            emptySeen.delete(library.id);
            break;
          }
          const file = path.join(dir, name);
          const info = await stat(file).catch(() => undefined);
          if (!info?.isFile() || deps.now() - info.mtimeMs < FRESH_MS) continue;
          try { await deps.remove(file); removed += 1; }
          catch (error) { log("WARN", "A thumbnail could not be deleted", { reason: String(error).slice(0, 200) }); }
        }
      } catch (error) {
        log("WARN", "A library's thumbnails could not be swept", { library: library.name, reason: String(error).slice(0, 200) });
      }
    }
    if (removed) log("INFO", "Orphaned thumbnails deleted", { removed });
    return { removed };
  };
}
