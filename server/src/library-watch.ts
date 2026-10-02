import { watch, type FSWatcher } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import { isVideo } from "./library.js";
import { log } from "./logger.js";

export interface LibraryWatch {
  /** False when the platform or the mount gave us no usable watch. */
  active: boolean;
  close(): void;
}

/** Folders a NAS or the system keeps beside the films: Synology's @eaDir holds a
 *  folder for every video, #recycle the deleted ones. Nothing in them is a title. */
export const skippedFolder = (name: string) => name.startsWith(".") || name.startsWith("@") || name.startsWith("#");

/** Recursive watching is what a network mount is worst at: an SMB or NFS share
 *  delivers no inotify events at all. The watch is therefore only an accelerator --
 *  the periodic check is what actually guarantees a copied file is noticed. */
export function watchLibrary(
  dir: string,
  onChange: (file: string) => void,
  { debounceMs = 30_000, timer = setTimeout, clear = clearTimeout, platform = process.platform }: {
    debounceMs?: number;
    timer?: typeof setTimeout;
    clear?: typeof clearTimeout;
    platform?: NodeJS.Platform;
  } = {},
): LibraryWatch {
  let pending: ReturnType<typeof setTimeout> | undefined;
  let last = "";

  const settle = (file: string) => {
    last = file;
    if (pending) clear(pending);
    // A copy lands as a long burst of events, and a half-written file is worth
    // nothing to the scanner, so the run waits for the tree to go quiet.
    pending = timer(() => { pending = undefined; onChange(last); }, debounceMs);
    if (typeof pending === "object" && "unref" in pending) pending.unref();
  };
  const noticed = (name: string) => {
    if (name.split(/[\\/]/).some(skippedFolder)) return;
    if (name && !isVideo(name) && path.extname(name)) return;
    settle(name);
  };

  try {
    const tree = platform === "linux" ? watchFolders(dir, noticed) : watchRecursive(dir, noticed);
    return {
      active: true,
      close: () => {
        if (pending) clear(pending);
        tree.close();
      },
    };
  } catch (error) {
    log("INFO", "The library cannot be watched here, relying on the periodic check", { reason: error instanceof Error ? error.message : String(error) });
    return { active: false, close: () => { if (pending) clear(pending); } };
  }
}

const stopped = (error: unknown) => {
  log("INFO", "The library watch stopped, the periodic check takes over", { reason: error instanceof Error ? error.message : String(error) });
};

/** macOS and Windows watch a whole tree through one handle. */
function watchRecursive(dir: string, noticed: (name: string) => void) {
  let watcher: FSWatcher | undefined = watch(dir, { recursive: true, persistent: false }, (_event, filename) => {
    noticed(typeof filename === "string" ? filename : "");
  });
  watcher.on("error", (error) => { stopped(error); watcher?.close(); watcher = undefined; });
  return { close: () => { watcher?.close(); watcher = undefined; } };
}

/** Linux has one inotify watch per path, and Node's recursive watch spends one on every file
 *  as well as every folder -- with Synology's @eaDir beside each video that runs out of the
 *  system's watches on an ordinary library. A folder's watch already reports the files in it,
 *  so only folders are watched, and the system's own are left out. */
function watchFolders(root: string, noticed: (name: string) => void) {
  const watchers = new Map<string, FSWatcher>();
  let closed = false;

  const closeAll = () => {
    closed = true;
    for (const watcher of watchers.values()) watcher.close();
    watchers.clear();
  };
  const fail = (error: unknown) => { if (closed) return; stopped(error); closeAll(); };

  const add = (folder: string) => {
    if (closed || watchers.has(folder)) return;
    const watcher = watch(folder, { persistent: false }, (_event, filename) => {
      const name = typeof filename === "string" ? filename : "";
      const relative = path.relative(root, name ? path.join(folder, name) : folder);
      noticed(relative);
      if (!name || skippedFolder(name)) return;
      // A folder that appeared needs its own watch, and one that went takes its watches with it.
      const child = path.join(folder, name);
      void stat(child).then(
        (info) => { if (info.isDirectory()) void walk(child); },
        () => { for (const [watched, gone] of watchers) if (watched === child || watched.startsWith(`${child}${path.sep}`)) { gone.close(); watchers.delete(watched); } },
      );
    });
    watcher.on("error", (error) => {
      // A watched folder that is deleted reports itself gone; only the root going, or the
      // system refusing more watches, ends the whole watch.
      if (folder !== root && (error as NodeJS.ErrnoException).code !== "ENOSPC") { watcher.close(); watchers.delete(folder); return; }
      fail(error);
    });
    watchers.set(folder, watcher);
  };

  const walk = async (folder: string) => {
    try { add(folder); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOSPC" || folder === root) fail(error);
      return;
    }
    let entries;
    try { entries = await readdir(folder, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (closed) return;
      if (entry.isDirectory() && !skippedFolder(entry.name)) await walk(path.join(folder, entry.name));
    }
  };

  // The root is watched at once, so a library that cannot be watched at all is known now.
  add(root);
  void walk(root);
  return { close: closeAll };
}
