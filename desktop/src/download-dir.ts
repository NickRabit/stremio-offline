import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { renameWithRetry } from "./fs-retry.js";
import { pathFor } from "./platform.js";

export type DownloadDirFailure = "not-absolute" | "not-folder" | "not-writable" | "reserved";

/** `owned`: the app created the folder, or found it empty, and it is no folder the user keeps
 *  anyway — only then may a reset move it to the Trash as a whole. */
export type DownloadDirResult = { ok: true; dir: string; owned: boolean } | { ok: false; reason: DownloadDirFailure };

/** The places the checks measure a folder against. */
export interface Places {
  home: string;
  userData: string;
  /** The operating system whose path rules and case sensitivity apply. */
  platform?: NodeJS.Platform;
  /** Known folders (Videos, Desktop, ...) as the system resolves them, so a folder of the user's
   *  that OneDrive or another drive moved out of the home folder is still recognized. */
  knownFolders?: string[];
}

/** The file operations the check needs, so a test can fail one of them on purpose. */
export interface DownloadDirFs {
  stat(entry: string): Promise<{ isDirectory(): boolean }>;
  readdir(dir: string): Promise<string[]>;
  mkdir(dir: string, options: { recursive: true }): Promise<unknown>;
  writeFile(file: string, data: string, options: { encoding: "utf8"; flag: "wx" }): Promise<unknown>;
  rm(file: string, options: { force: true }): Promise<unknown>;
  realpath(entry: string): Promise<string>;
}

// `fs/promises`'s realpath has the semantics of `fs.realpath.native`: an 8.3 name and a junction
// both answer with the folder they stand for.
const nodeFs: DownloadDirFs = { stat, readdir, mkdir, writeFile, rm, realpath };

const MAX_PATH = 1024;
const PROBE_PREFIX = ".stremio-offline-write-test-";
/** Folders macOS gives every account: fine to download into, never the app's to throw away. */
const HOME_FOLDERS = ["Applications", "Desktop", "Documents", "Downloads", "Library", "Movies", "Music", "Pictures", "Public"];
/** The same for Windows, directly under the profile folder. */
const WINDOWS_HOME_FOLDERS = [
  "Desktop", "Documents", "Downloads", "Music", "Pictures", "Videos", "AppData",
  "Saved Games", "Contacts", "Favorites", "Links", "Searches", "3D Objects", "OneDrive",
];
/** A work account gets its own folder next to OneDrive, spelled by the account name. */
const ONEDRIVE_WORK_PREFIX = "onedrive - ";
/** Finder's and Explorer's own files do not make a folder the user's. */
const IGNORED_ENTRIES = new Set([".DS_Store", ".localized", "desktop.ini", "Thumbs.db"]);

const platformOf = (places: Places): NodeJS.Platform => places.platform ?? process.platform;
const knownFoldersOf = (places: Places): readonly string[] => places.knownFolders ?? [];

/** Windows compares paths without case; a POSIX path is taken as it is written. */
const samePath = (a: string, b: string, platform: NodeJS.Platform): boolean =>
  platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;

const inside = (child: string, parent: string, pathImpl: typeof path) => {
  const relative = pathImpl.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !pathImpl.isAbsolute(relative));
};

/** A folder Windows accepts as a full path: a drive letter or a share. `\films` alone is rooted
 *  but belongs to whatever drive the process happens to be on. */
const isAbsolute = (dir: string, platform: NodeJS.Platform): boolean => {
  const pathImpl = pathFor(platform);
  if (!pathImpl.isAbsolute(dir)) return false;
  return platform !== "win32" || pathImpl.parse(dir).root.length > 1;
};

/** `entry` and every folder above it, stopping before the drive or share root. */
const folderAndParents = (entry: string, pathImpl: typeof path, platform: NodeJS.Platform): string[] => {
  const folders: string[] = [];
  let current = pathImpl.resolve(entry);
  while (!samePath(current, pathImpl.parse(current).root, platform)) {
    folders.push(current);
    current = pathImpl.dirname(current);
  }
  return folders;
};

/** The folder as the file system spells it: an 8.3 name and a junction both answer with the real
 *  one. An entry that cannot be resolved stands for itself. */
const realPath = async (entry: string, fsImpl: DownloadDirFs): Promise<string> => {
  try {
    return await fsImpl.realpath(entry);
  } catch {
    return entry;
  }
};

/** A folder that cannot be the download folder: the disk root, the home folder or anything above
 *  it, and the app's own data (its own `downloads` default excepted). */
export function reservedDownloadDir(dir: string, places: Places): boolean {
  const platform = platformOf(places);
  const pathImpl = pathFor(platform);
  const resolved = pathImpl.resolve(dir);
  if (samePath(resolved, pathImpl.parse(resolved).root, platform)) return true;
  if (inside(places.home, resolved, pathImpl)) return true;
  if (inside(places.userData, resolved, pathImpl)) return true;
  return inside(resolved, places.userData, pathImpl) && !samePath(resolved, pathImpl.join(places.userData, "downloads"), platform);
}

/** A folder the user keeps whatever the app does: a home folder the system names, a macOS volume
 *  root, a known folder of the system (OneDrive move, another drive) or one above such a folder. */
export function protectedDownloadDir(dir: string, places: Places): boolean {
  const platform = platformOf(places);
  const pathImpl = pathFor(platform);
  const resolved = pathImpl.resolve(dir);
  const home = pathImpl.resolve(places.home);
  if (platform === "win32") {
    const named = WINDOWS_HOME_FOLDERS.some((name) => samePath(resolved, pathImpl.join(home, name), platform));
    if (named) return true;
    const name = pathImpl.basename(resolved).toLowerCase();
    if (name.startsWith(ONEDRIVE_WORK_PREFIX) && samePath(pathImpl.dirname(resolved), home, platform)) return true;
  } else {
    if (HOME_FOLDERS.some((name) => samePath(resolved, pathImpl.join(home, name), platform))) return true;
    if (/^\/Volumes\/[^/]+$/.test(resolved)) return true;
  }
  return knownFoldersOf(places).some((folder) =>
    folderAndParents(folder, pathImpl, platform).some((entry) => samePath(entry, resolved, platform)));
}

/** A path segment naming OneDrive: the plain folder or a work account's `OneDrive - ...`. */
const isOneDriveSegment = (segment: string): boolean => {
  const name = segment.toLowerCase();
  return name === "onedrive" || name.startsWith("onedrive - ");
};

/** Where the setup step proposes to download to. A Videos folder that lives in OneDrive would sync
 *  every film to the cloud, so Windows suggests a folder beside the profile instead. */
export function suggestedDownloadDir(home: string, videos: string, platform: NodeJS.Platform = process.platform): string {
  const pathImpl = pathFor(platform);
  const inOneDrive = pathImpl.resolve(videos).split(pathImpl.sep).some(isOneDriveSegment);
  return platform === "win32" && inOneDrive
    ? pathImpl.join(home, "Stremio Offline")
    : pathImpl.join(videos, "Stremio Offline");
}

/** Creates the folder when it is missing and writes a probe file, so the setup step can tell
 *  the user before the backend does that downloads cannot land there. */
export async function prepareDownloadDir(dir: unknown, places: Places, fsImpl: DownloadDirFs = nodeFs): Promise<DownloadDirResult> {
  const platform = platformOf(places);
  const pathImpl = pathFor(platform);
  if (typeof dir !== "string" || !isAbsolute(dir, platform) || dir.length > MAX_PATH || dir.includes("\0")) {
    return { ok: false, reason: "not-absolute" };
  }
  const resolved = pathImpl.resolve(dir);
  if (reservedDownloadDir(resolved, places)) return { ok: false, reason: "reserved" };
  // Only a folder created here, or one whose contents were read and found empty, is the app's:
  // a folder it cannot list may hold anything.
  let fresh = false;
  let exists = true;
  try {
    if (!(await fsImpl.stat(resolved)).isDirectory()) return { ok: false, reason: "not-folder" };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") return { ok: false, reason: "not-writable" };
    exists = false;
  }
  // The same folder under another spelling -- an 8.3 name, a junction -- is still that folder.
  let spelledReserved = false;
  let spelledProtected = false;
  if (exists) {
    const real = await realPath(resolved, fsImpl);
    if (!samePath(real, resolved, platform)) {
      const realPlaces: Places = {
        ...places,
        home: await realPath(places.home, fsImpl),
        userData: await realPath(places.userData, fsImpl),
        knownFolders: await Promise.all(knownFoldersOf(places).map((folder) => realPath(folder, fsImpl))),
      };
      spelledReserved = reservedDownloadDir(real, realPlaces);
      spelledProtected = protectedDownloadDir(real, realPlaces);
    }
    fresh = await fsImpl.readdir(resolved).then((entries) => entries.every((entry) => IGNORED_ENTRIES.has(entry)), () => false);
  } else {
    try {
      await fsImpl.mkdir(resolved, { recursive: true });
      fresh = true;
    } catch {
      return { ok: false, reason: "not-writable" };
    }
  }
  if (spelledReserved) return { ok: false, reason: "reserved" };
  const probe = pathImpl.join(resolved, `${PROBE_PREFIX}${randomUUID()}`);
  try {
    await fsImpl.writeFile(probe, "", { encoding: "utf8", flag: "wx" });
  } catch {
    return { ok: false, reason: "not-writable" };
  }
  await fsImpl.rm(probe, { force: true }).catch(() => {});
  return { ok: true, dir: resolved, owned: fresh && !spelledProtected && !protectedDownloadDir(resolved, places) };
}

export const OWNERSHIP_FILE = "download-folder.json";

/** Whether the stored download folder is the app's to throw away, recorded when it was adopted. */
export interface Ownership { dir: string; owned: boolean }

export async function readOwnership(userData: string): Promise<Ownership | null> {
  try {
    const body = JSON.parse(await readFile(path.join(userData, OWNERSHIP_FILE), "utf8")) as Record<string, unknown>;
    return typeof body.dir === "string" && typeof body.owned === "boolean" ? { dir: body.dir, owned: body.owned } : null;
  } catch {
    return null;
  }
}

export async function writeOwnership(userData: string, ownership: Ownership): Promise<void> {
  await mkdir(userData, { recursive: true });
  const temporary = path.join(userData, `${OWNERSHIP_FILE}.${randomUUID()}`);
  try {
    await writeFile(temporary, JSON.stringify(ownership) + "\n", { encoding: "utf8", flag: "wx" });
    await renameWithRetry(temporary, path.join(userData, OWNERSHIP_FILE));
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}

/** Only a folder recorded as owned, still the stored one, and still not reserved or protected. The
 *  default `<userData>/downloads` is the app's own. */
export function mayTrashDownloadDir(dir: string, stored: string | null, ownership: Ownership | null, places: Places): boolean {
  const platform = platformOf(places);
  const pathImpl = pathFor(platform);
  const resolved = pathImpl.resolve(dir);
  if (reservedDownloadDir(resolved, places) || protectedDownloadDir(resolved, places)) return false;
  if (stored === null) return samePath(resolved, pathImpl.join(places.userData, "downloads"), platform);
  return ownership !== null && ownership.owned
    && samePath(pathImpl.resolve(ownership.dir), resolved, platform)
    && samePath(pathImpl.resolve(stored), resolved, platform);
}
