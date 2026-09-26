import { randomUUID } from "node:crypto";
import { mkdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

export type DownloadDirFailure = "not-absolute" | "not-folder" | "not-writable";

export type DownloadDirResult = { ok: true; dir: string } | { ok: false; reason: DownloadDirFailure };

/** The file operations the check needs, so a test can fail one of them on purpose. */
export interface DownloadDirFs {
  stat(entry: string): Promise<{ isDirectory(): boolean }>;
  mkdir(dir: string, options: { recursive: true }): Promise<unknown>;
  writeFile(file: string, data: string, options: { encoding: "utf8"; flag: "wx" }): Promise<unknown>;
  rm(file: string, options: { force: true }): Promise<unknown>;
}

const nodeFs: DownloadDirFs = { stat, mkdir, writeFile, rm };

const MAX_PATH = 1024;
const PROBE_PREFIX = ".stremio-offline-write-test-";

/** Creates the folder when it is missing and writes a probe file, so the setup step can tell
 *  the user before the backend does that downloads cannot land there. */
export async function prepareDownloadDir(dir: unknown, fsImpl: DownloadDirFs = nodeFs): Promise<DownloadDirResult> {
  if (typeof dir !== "string" || !path.isAbsolute(dir) || dir.length > MAX_PATH || dir.includes("\0")) {
    return { ok: false, reason: "not-absolute" };
  }
  const resolved = path.resolve(dir);
  try {
    if (!(await fsImpl.stat(resolved)).isDirectory()) return { ok: false, reason: "not-folder" };
  } catch {
    try {
      await fsImpl.mkdir(resolved, { recursive: true });
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
  return { ok: true, dir: resolved };
}
