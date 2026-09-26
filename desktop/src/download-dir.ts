import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

export type DownloadDirFailure = "not-absolute" | "not-folder" | "not-writable" | "reserved";

/** `owned`: the app created the folder, or found it empty, and it is no folder the user keeps
 *  anyway — only then may a reset move it to the Trash as a whole. */
export type DownloadDirResult = { ok: true; dir: string; owned: boolean } | { ok: false; reason: DownloadDirFailure };

/** The places the checks measure a folder against. */
export interface Places {
  home: string;
  userData: string;
}

/** The file operations the check needs, so a test can fail one of them on purpose. */
export interface DownloadDirFs {
  stat(entry: string): Promise<{ isDirectory(): boolean }>;
  readdir(dir: string): Promise<string[]>;
  mkdir(dir: string, options: { recursive: true }): Promise<unknown>;
  writeFile(file: string, data: string, options: { encoding: "utf8"; flag: "wx" }): Promise<unknown>;
  rm(file: string, options: { force: true }): Promise<unknown>;
}

const nodeFs: DownloadDirFs = { stat, readdir, mkdir, writeFile, rm };

const MAX_PATH = 1024;
const PROBE_PREFIX = ".stremio-offline-write-test-";
/** Folders macOS gives every account: fine to download into, never the app's to throw away. */
const HOME_FOLDERS = ["Applications", "Desktop", "Documents", "Downloads", "Library", "Movies", "Music", "Pictures", "Public"];
/** Finder's own files do not make a folder the user's. */
const IGNORED_ENTRIES = new Set([".DS_Store", ".localized"]);

const inside = (child: string, parent: string) => {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
};

/** A folder that cannot be the download folder: the disk root, the home folder or anything above
 *  it, and the app's own data (its own `downloads` default excepted). */
export function reservedDownloadDir(dir: string, places: Places): boolean {
  const resolved = path.resolve(dir);
  if (resolved === path.parse(resolved).root) return true;
  if (inside(places.home, resolved)) return true;
  if (inside(places.userData, resolved)) return true;
  return inside(resolved, places.userData) && resolved !== path.join(places.userData, "downloads");
}

/** A folder the user keeps whatever the app does: a macOS home folder or a volume root. */
export function protectedDownloadDir(dir: string, places: Places): boolean {
  const resolved = path.resolve(dir);
  if (HOME_FOLDERS.some((name) => resolved === path.join(places.home, name))) return true;
  return /^\/Volumes\/[^/]+$/.test(resolved);
}

/** Creates the folder when it is missing and writes a probe file, so the setup step can tell
 *  the user before the backend does that downloads cannot land there. */
export async function prepareDownloadDir(dir: unknown, places: Places, fsImpl: DownloadDirFs = nodeFs): Promise<DownloadDirResult> {
  if (typeof dir !== "string" || !path.isAbsolute(dir) || dir.length > MAX_PATH || dir.includes("\0")) {
    return { ok: false, reason: "not-absolute" };
  }
  const resolved = path.resolve(dir);
  if (reservedDownloadDir(resolved, places)) return { ok: false, reason: "reserved" };
  let fresh = false;
  try {
    if (!(await fsImpl.stat(resolved)).isDirectory()) return { ok: false, reason: "not-folder" };
    fresh = (await fsImpl.readdir(resolved)).every((entry) => IGNORED_ENTRIES.has(entry));
  } catch {
    try {
      await fsImpl.mkdir(resolved, { recursive: true });
      fresh = true;
    } catch {
      return { ok: false, reason: "not-writable" };
    }
  }
  const probe = path.join(resolved, `${PROBE_PREFIX}${randomUUID()}`);
  try {
    await fsImpl.writeFile(probe, "", { encoding: "utf8", flag: "wx" });
  } catch {
    return { ok: false, reason: "not-writable" };
  }
  await fsImpl.rm(probe, { force: true }).catch(() => {});
  return { ok: true, dir: resolved, owned: fresh && !protectedDownloadDir(resolved, places) };
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
    await rename(temporary, path.join(userData, OWNERSHIP_FILE));
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}

/** Only a folder recorded as owned, still the stored one, and still not reserved or protected. The
 *  default `<userData>/downloads` is the app's own. */
export function mayTrashDownloadDir(dir: string, stored: string | null, ownership: Ownership | null, places: Places): boolean {
  const resolved = path.resolve(dir);
  if (reservedDownloadDir(resolved, places) || protectedDownloadDir(resolved, places)) return false;
  if (stored === null) return resolved === path.join(places.userData, "downloads");
  return ownership !== null && ownership.owned && path.resolve(ownership.dir) === resolved && path.resolve(stored) === resolved;
}
