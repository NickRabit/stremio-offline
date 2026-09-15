import { mkdir, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { grantingRoot } from "./library-grants.js";
import { isInside, type LibraryRecord, type LibraryType, type RootGrant } from "./libraries.js";

/** A root the deployment will accept, or why it will not. The message carries the catalogue
 *  key the interface renders it with; the English text is the fallback. */
export type RootCheck = { ok: true; root: string } | { ok: false; message: string; messageKey: string; status?: number };

export const asLibraryType = (value: unknown): LibraryType | undefined =>
  value === "movie" || value === "series" || value === "mixed" ? value : undefined;

const refuse = (message: string, messageKey: string, status?: number): RootCheck =>
  ({ ok: false, message, messageKey, ...(status === undefined ? {} : { status }) });

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
    catch { return refuse("The folder could not be created.", "err.libraryRootCreate"); }
  }
  // Compared through realpath: two mounts of the same disk are one root, not two.
  const real = await realpath(root).catch(() => root);
  for (const library of opts.libraries) {
    if (library.id === opts.exceptId) continue;
    const other = await realpath(library.root).catch(() => path.resolve(library.root));
    if (other === real) return refuse("Another library already uses that folder.", "err.libraryRootTaken");
  }
  return { ok: true, root };
}

/** Whether a folder already sits in a library, and whether it is one of their roots. */
export function libraryFlag(libraries: LibraryRecord[], target: string) {
  const absolute = path.resolve(target);
  const owner = libraries.find((library) => isInside(absolute, path.resolve(library.root)));
  return owner ? { libraryId: owner.id, libraryRoot: path.resolve(owner.root) === absolute } : {};
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
