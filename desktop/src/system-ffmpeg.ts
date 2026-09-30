import { execFile } from "node:child_process";
import { accessSync, constants, statSync } from "node:fs";
import path from "node:path";

export interface SystemFfmpeg {
  ffmpeg: string;
  ffprobe: string;
}

/** How long the version probe may take before the build counts as unusable. */
export const SYSTEM_FFMPEG_TIMEOUT_MS = 5_000;

/** The first executable of `name` in a `PATH` value, or null. */
export type PathLookup = (name: string, pathValue: string) => Promise<string | null>;
/** The output of `<file> -version`. */
export type VersionRunner = (file: string, timeoutMs: number) => Promise<string>;

const isExecutable = (file: string): boolean => {
  try {
    if (!statSync(file).isFile()) return false;
    accessSync(file, constants.X_OK);
    return true;
  } catch {
    return false;
  }
};

const lookupOnPath: PathLookup = async (name, pathValue) => {
  for (const dir of pathValue.split(path.delimiter)) {
    if (dir.length === 0) continue;
    const candidate = path.join(dir, name);
    if (isExecutable(candidate)) return candidate;
  }
  return null;
};

const readVersion: VersionRunner = (file, timeoutMs) =>
  new Promise((resolve, reject) => {
    execFile(file, ["-version"], { timeout: timeoutMs, encoding: "utf8", maxBuffer: 1 << 20 }, (error, stdout, stderr) => {
      if (error) reject(error);
      else resolve(`${stdout}${stderr}`);
    });
  });

/** The system `ffmpeg` and its `ffprobe`, but only on Linux and only when that build carries a
 *  software H.264 encoder, which the bundled LGPL build does not. */
export async function findSystemFfmpeg(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
  which: PathLookup = lookupOnPath,
  exec: VersionRunner = readVersion,
): Promise<SystemFfmpeg | null> {
  if (platform !== "linux") return null;
  const pathValue = env.PATH ?? "";
  const ffmpeg = await which("ffmpeg", pathValue);
  if (ffmpeg === null) return null;
  const ffprobe = (await which("ffprobe", path.dirname(ffmpeg))) ?? (await which("ffprobe", pathValue));
  if (ffprobe === null) return null;
  try {
    const output = await exec(ffmpeg, SYSTEM_FFMPEG_TIMEOUT_MS);
    return output.includes("--enable-libx264") ? { ffmpeg, ffprobe } : null;
  } catch {
    return null;
  }
}
