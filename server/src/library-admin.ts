import { mkdir, readdir, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { grantingRoot } from "./library-grants.js";
import { isInside, realTarget, sameFile, type LibraryRecord, type LibraryType, type RootGrant } from "./libraries.js";
import type { FinishOutcome, LibraryOp, OpsState } from "./library-ops.js";
import { log } from "./logger.js";

/** A root the deployment will accept, or why it will not. The message carries the catalogue
 *  key the interface renders it with; the English text is the fallback. */
export type RootCheck = { ok: true; root: string } | { ok: false; message: string; messageKey: string; status?: number };

/** Whether a library's whole tree may be moved into another folder, and what has to move. */
export type RerootCheck = { ok: true; items: string[] } | { ok: false; message: string; messageKey: string; status: number };

export const asLibraryType = (value: unknown): LibraryType | undefined =>
  value === "movie" || value === "series" || value === "mixed" ? value : undefined;

const refuse = (message: string, messageKey: string, status?: number): RootCheck =>
  ({ ok: false, message, messageKey, ...(status === undefined ? {} : { status }) });

const refuseReroot = (message: string, messageKey: string, status: number): RerootCheck =>
  ({ ok: false, message, messageKey, status });

const namesIn = (folder: string) => readdir(folder).catch(() => [] as string[]);

/** The refusals that are about paths alone, so they can run before anything is created.
 *  A carve-out is refused whatever else is wrong with the destination, because moving
 *  another library along is a thing this deployment never does. */
export async function checkRerootPaths(opts: {
  from: string;
  to: string;
  /** Roots of other libraries that sit inside `from`, as `carveOuts` reports them. */
  carveOuts: string[];
}): Promise<RerootCheck> {
  if (opts.carveOuts.length) {
    return refuseReroot("Another library sits inside this one. Move it out first, or point at the new folder without moving.", "err.libraryRerootCarveOut", 409);
  }
  // Compared through realpath: the same folder under two names is one folder, and a nested
  // one would be dragged along or would swallow the tree that is being moved. A destination
  // that does not exist yet resolves through its nearest real ancestor, so `create` cannot
  // sneak one root inside the other.
  // Both sides resolved the same way, and the destination keeps the part of itself that
  // does not exist yet. Resolving the destination only as far as it exists made every new
  // folder read as its parent, so "make a folder next to this one and move the content
  // there" -- a sibling of the old root -- was refused as being inside it.
  const [from, to] = await Promise.all([realTarget(opts.from), realTarget(opts.to)]);
  if (from === to || isInside(to, from) || isInside(from, to)) {
    return refuseReroot("The new folder is inside the old one.", "err.libraryRerootNested", 409);
  }
  return { ok: true, items: [] };
}

/** What has to move, once the destination is known to exist. It only reads: the names are
 *  read once, here, and the enqueue decides what moves -- the pump only walks that list. */
export async function checkRerootItems(opts: { from: string; to: string }): Promise<RerootCheck> {
  const items = await namesIn(opts.from);
  if (!items.length) return refuseReroot("There is nothing in this folder to move.", "err.libraryRerootEmpty", 409);
  const taken = new Set(await namesIn(opts.to));
  if (items.some((name) => taken.has(name))) {
    return refuseReroot("The new folder already holds something with the same name.", "err.libraryRerootCollision", 409);
  }
  return { ok: true, items };
}

/** A root has to be absolute, inside a granted root, a folder, and not another library's
 *  root. A root inside another library's root is legal: that is the carve-out, and it is
 *  what makes the legacy `/downloads` install splittable without moving anything. */
export async function checkLibraryRoot(opts: {
  grants: RootGrant[];
  libraries: LibraryRecord[];
  root: unknown;
  create?: boolean;
  exceptId?: string;
}): Promise<RootCheck> {
  const raw = String(opts.root ?? "").trim();
  if (!raw) return refuse("A library needs a root.", "err.libraryRootRequired");
  if (!path.isAbsolute(raw)) return refuse("The root has to be an absolute path.", "err.libraryRootAbsolute");
  const root = path.resolve(raw);
  if (!await grantingRoot(opts.grants, root)) {
    return refuse("That folder is outside every granted root.", "err.libraryRootNotGranted", 403);
  }
  const info = await stat(root).catch(() => undefined);
  if (info && !info.isDirectory()) return refuse("The root has to be a folder.", "err.libraryRootNotFolder");
  if (!info) {
    if (!opts.create) return refuse("The folder does not exist.", "err.pathMissing");
    // Inside the grant, checked above; a race with something else creating it is fine.
    try { await mkdir(root, { recursive: true }); }
    catch (error) {
      // The interface says only that it failed. EACCES on a NAS share, EROFS on a read-only
      // mount and ENOSPC are three different evenings for whoever has to fix it, and the
      // errno is the one thing that tells them apart.
      log("WARN", "A library root could not be created", {
        root, code: (error as NodeJS.ErrnoException)?.code,
        reason: error instanceof Error ? error.message : String(error),
      });
      return refuse("The folder could not be created.", "err.libraryRootCreate");
    }
  }
  // Compared through realpath: two mounts of the same disk are one root, not two.
  const real = await realpath(root).catch(() => root);
  for (const library of opts.libraries) {
    if (library.id === opts.exceptId) continue;
    const other = await realpath(library.root).catch(() => path.resolve(library.root));
    if (sameFile(other, real)) return refuse("Another library already uses that folder.", "err.libraryRootTaken");
  }
  return { ok: true, root };
}

/** Whether a folder already sits in a library, and whether it is one of their roots. */
export function libraryFlag(libraries: LibraryRecord[], target: string) {
  const absolute = path.resolve(target);
  const owner = libraries.find((library) => isInside(absolute, path.resolve(library.root)));
  return owner ? { libraryId: owner.id, libraryRoot: sameFile(path.resolve(owner.root), absolute) } : {};
}

/** Whether a library may be removed. The last one may not: an empty set breaks every
 *  unqualified path until a restart, and the restart seeds a new id that matches nothing
 *  the old library remembered. */
export type RemovalCheck = { ok: true; library: LibraryRecord } | { ok: false; message: string; messageKey: string; status: number };

export function checkLibraryRemoval(libraries: LibraryRecord[], id: string): RemovalCheck {
  const library = libraries.find((record) => record.id === id);
  if (!library) return { ok: false, message: "The library was not found.", messageKey: "err.libraryNotFound", status: 404 };
  if (libraries.length === 1) {
    return {
      ok: false,
      message: "This is the only library. Point it at another folder instead of removing it.",
      messageKey: "err.libraryLast",
      status: 409,
    };
  }
  return { ok: true, library };
}

/** Every write that gives a library a folder -- a create, an edit of the root, the end of a
 *  re-root -- runs one after another under this lock, and checks the folder afresh inside it.
 *  A check before the lock could not see a folder another write was about to take, and a
 *  check inside a state write cannot resolve a symlink. */
let rootChain: Promise<unknown> = Promise.resolve();
export function withLibraryRootLock<T>(work: () => Promise<T>): Promise<T> {
  const run = rootChain.then(work, work);
  rootChain = run.catch(() => undefined);
  return run;
}

/** Whether another library already uses the folder, through realpath on both sides. */
export async function libraryRootTaken(libraries: LibraryRecord[], root: string, exceptId?: string): Promise<boolean> {
  const real = await realpath(root).catch(() => path.resolve(root));
  for (const library of libraries) {
    if (library.id === exceptId) continue;
    const other = await realpath(library.root).catch(() => path.resolve(library.root));
    if (sameFile(other, real)) return true;
  }
  return false;
}

/** The `finished` hook of a re-root: once every item is across, the library points at the new
 *  folder. A switch it cannot make is a failed job the interface shows and the next start
 *  retries, not a success with a warning in the log. */
export function switchRerootedRoot(deps: {
  libraries: () => LibraryRecord[];
  update: (mutate: (state: { libraries?: LibraryRecord[] }) => void) => Promise<void>;
  switched: () => Promise<void>;
}) {
  return async (job: OpsState, operation: LibraryOp): Promise<FinishOutcome | void> => {
    if (operation.op !== "reroot") return;
    // Every item went over. The status is not the test: a start that retries a switch the
    // last one could not make sees the job it marked `failed` itself.
    if (job.failed > 0 || job.done < job.total) return;
    // Somebody pointed the library elsewhere by hand, or removed it: the switch is theirs now.
    const current = deps.libraries().find((library) => library.id === operation.libraryId);
    if (!current || path.resolve(current.root) !== operation.from) return;
    // Under the root lock, with the folder checked afresh: a create or an edit that took the new
    // folder while the content moved owns it, and two libraries over one folder is worse than a
    // re-root that waits for somebody to look.
    const switched = await withLibraryRootLock(async () => {
      if (await libraryRootTaken(deps.libraries(), operation.to, operation.libraryId)) return false;
      await deps.update((state) => {
        state.libraries = (state.libraries ?? []).map((library) => library.id === operation.libraryId ? { ...library, root: operation.to } : library);
      });
      return true;
    });
    if (!switched) {
      log("WARN", "The re-rooted content is in place, but another library took the new folder meanwhile; the root was not switched", {
        library: operation.libraryId, from: operation.from, to: operation.to,
      });
      return {
        error: `The content is now in ${operation.to}, but another library took that folder meanwhile, so this library still points to ${operation.from}.`,
        errorKey: "err.libraryRerootTaken",
        vars: { from: operation.from, to: operation.to },
      };
    }
    await deps.switched();
    log("INFO", "Library re-rooted, the content came along", {
      library: operation.libraryId, from: operation.from, root: operation.to, items: operation.items.length,
    });
  };
}
