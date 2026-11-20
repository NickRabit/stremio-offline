import path from "node:path";
import { AppError } from "./errors.js";
import { statUnlessMissing } from "./folder-access.js";
import type { LibraryHealth } from "./library-probe.js";
import { holdsLibraryRoot } from "./library.js";
import { placed, posixDir, posixJoin, resolveLibraryPath, sameFile, type LibraryRecord, type ResolvedPath } from "./libraries.js";
import { assertUsableName } from "./naming.js";
import type { PathReservations } from "./path-reservations.js";
import type { RenameRequest } from "./library-rename-recovery.js";
import { assertStillAdmin } from "./roles.js";
import type { Store } from "./store.js";
import type { UserRecord } from "./users.js";

export interface RenameEntryDeps {
  store: Pick<Store, "libraries" | "users">;
  carveOutsOf(library: LibraryRecord): ReadonlySet<string>;
  healthOf(library: LibraryRecord): LibraryHealth;
  fileExists(file: string): Promise<boolean>;
  libraryPathBusy(keys: string[], options?: { ignoreReservations?: boolean }): Promise<string | undefined>;
  pathReservations: PathReservations;
  renameLibraryItem(request: RenameRequest): Promise<void>;
  invalidateLibrary(): void;
}

export type RenameEntry = (
  relative: string,
  typedName: string,
  actor: UserRecord | undefined,
  options?: { queued?: boolean },
) => Promise<string>;

export function createRenameEntry(deps: RenameEntryDeps): RenameEntry {
  return async (relative, typedName, actor, options = {}) => {
    const resolved: ResolvedPath | undefined = relative ? await resolveLibraryPath(deps.store.libraries(), relative) : undefined;
    if (!resolved || !resolved.relative) throw new AppError("Invalid path.", "err.invalidPath");
    if (!options.queued && await deps.libraryPathBusy([relative])) throw busy();
    const info = await statUnlessMissing(resolved.absolute);
    if (!info) throw new AppError("The file or folder does not exist.", "err.pathMissing");
    if (holdsLibraryRoot(deps.carveOutsOf(resolved.library), resolved.relative, deps.healthOf(resolved.library).caseInsensitive)) {
      throw new AppError("This folder holds another library. Move that library out first.", "err.libraryHoldsAnother", 409);
    }

    const extension = info.isDirectory() ? "" : path.extname(relative);
    const typed = typedName.trim();
    const stem = extension && typed.toLowerCase().endsWith(extension.toLowerCase()) ? typed.slice(0, -extension.length) : typed;
    const wanted = assertUsableName(stem);
    const nextRelative = posixJoin(posixDir(relative), `${wanted}${extension}`);
    const target = await resolveLibraryPath(deps.store.libraries(), nextRelative);
    if (!target) throw new AppError("Invalid path.", "err.invalidPath");
    if (!sameFile(target.absolute, resolved.absolute, deps.healthOf(resolved.library).caseInsensitive)
      && await deps.fileExists(target.absolute)) throw new AppError("A file with that name already exists.", "err.nameTaken");

    assertStillAdmin(deps.store.users(), actor);
    if (!options.queued && await deps.libraryPathBusy([target.key])) throw busy();
    const release = deps.pathReservations.reserve(await Promise.all([placed(resolved), placed(target)]));
    if (!release) throw busy();
    try {
      if (!options.queued && await deps.libraryPathBusy([resolved.key, target.key], { ignoreReservations: true })) {
        throw busy();
      }
      await deps.renameLibraryItem({ actor, source: resolved, target });
    } finally {
      try {
        deps.invalidateLibrary();
      } finally {
        release();
      }
    }
    return nextRelative;
  };
}

const busy = () => new AppError("The item is busy with another library operation.", "err.pathBusy", 409);
