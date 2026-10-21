import type { Dirent, Stats } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { AppError } from "./errors.js";

const DENIED = new Set(["EACCES", "EPERM"]);
// A symlink loop or an overlong name resolves to nothing either; both were "missing" before.
const ABSENT = new Set(["ENOENT", "ENOTDIR", "ELOOP", "ENAMETOOLONG"]);

const codeOf = (error: unknown) => (error as NodeJS.ErrnoException | undefined)?.code;

/** A folder the server is not allowed into is not a missing one: on a NAS or in a container the
 *  first is a permission to fix, and calling it missing sends the administrator after the path. */
export const folderNoAccess = () => new AppError(
  "The server is not allowed to open that folder.", "err.folderNoAccess",
);

/** The stats of a path, or nothing when it is not there. Being refused is thrown, never read as
 *  absence; any other failure is thrown as it came. */
export async function statUnlessMissing(dir: string, statImpl: (file: string) => Promise<Stats> = stat): Promise<Stats | undefined> {
  try {
    return await statImpl(dir);
  } catch (error) {
    const code = codeOf(error);
    if (code !== undefined && ABSENT.has(code)) return undefined;
    if (code !== undefined && DENIED.has(code)) throw folderNoAccess();
    throw error;
  }
}

/** A folder that has to be there: missing and refused are two different answers. */
export async function existingFolder(dir: string, statImpl?: (file: string) => Promise<Stats>): Promise<Stats> {
  const info = await statUnlessMissing(dir, statImpl);
  if (!info?.isDirectory()) throw new AppError("The folder does not exist.", "err.pathMissing");
  return info;
}

/** The entries of a folder the server may be refused from listing; a refusal is not an empty folder. */
export async function folderEntries(dir: string, readdirImpl: (file: string) => Promise<Dirent[]> = (file) => readdir(file, { withFileTypes: true })): Promise<Dirent[]> {
  try {
    return await readdirImpl(dir);
  } catch (error) {
    const code = codeOf(error);
    if (code !== undefined && DENIED.has(code)) throw folderNoAccess();
    if (code !== undefined && ABSENT.has(code)) return [];
    throw error;
  }
}
