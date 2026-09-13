import { execFile } from "node:child_process";
import { access, readdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { log } from "./logger.js";
import { guardedFetch } from "./outbound.js";
import type { LibraryHealth } from "./library-probe.js";
import type { LibraryRecord } from "./libraries.js";

const run = promisify(execFile);

/** The names Emby and Jellyfin look for pictures under. The order is the priority. */
export const POSTER_NAMES = ["poster.jpg", "poster.png", "folder.jpg", "folder.png", "cover.jpg", "cover.png", "default.jpg"];
export const BACKDROP_NAMES = ["backdrop.jpg", "fanart.jpg", "background.jpg"];
/** Our own output. Jellyfin picks it up as the poster when it scans. */
export const POSTER_OUTPUT = "poster.jpg";

/** A generated poster lands next to the media only when the user asked for it *and* the
 *  library allows it. A read-only root, a root that is away and a library the user keeps
 *  curated all fall back to `data/artwork/<libraryId>/`, whatever the global setting says:
 *  dropping a file into somebody's archive is the one thing the setting must not do. */
export function artworkBesideMedia(
  setting: "data" | "media",
  library: Pick<LibraryRecord, "writeArtwork">,
  health: LibraryHealth,
): boolean {
  return setting === "media" && library.writeArtwork && !health.readOnly && !health.unreachable;
}

/** Jellyfin looks for an episode thumbnail under the file name; we write the same. */
export const episodeArtName = (videoFile: string) => `${videoFile.replace(/\.[^.]+$/, "")}.jpg`;

/** A bound movie already has a folder poster. A series episode must not inherit it. */
export function fileMayUseFolderArtwork(relative: string, titleType?: string): boolean {
  if (titleType !== "movie") return false;
  const parent = path.dirname(relative);
  return parent !== "." && parent !== "";
}

const exists = async (file: string) => { try { await access(file); return true; } catch { return false; } };

/** Returns the name of an existing picture in the folder, whoever produced it. */
export async function findArtwork(directory: string, names = POSTER_NAMES): Promise<string | undefined> {
  let entries: string[];
  try { entries = await readdir(directory); } catch { return undefined; }
  const lower = new Map(entries.map((name) => [name.toLowerCase(), name]));
  for (const candidate of names) {
    const found = lower.get(candidate);
    if (found) return found;
  }
  return undefined;
}

/** Written through a temporary file, so half a picture never shows up. */
async function writeAtomic(target: string, data: Buffer) {
  const temp = `${target}.tmp`;
  await writeFile(temp, data, { mode: 0o644 });
  await rename(temp, target);
}

/** Downloads a picture to an exact place. Used for the poster the client sent from the catalogue. */
export async function savePosterAs(target: string, url: string): Promise<boolean> {
  try {
    const response = await guardedFetch(url, { signal: AbortSignal.timeout(20_000) });
    if (!response.ok) return false;
    if (!(response.headers.get("content-type") ?? "").startsWith("image/")) return false;
    const data = Buffer.from(await response.arrayBuffer());
    if (!data.length || data.length > 8 * 1024 * 1024) return false;
    await writeAtomic(target, data);
    return true;
  } catch { return false; }
}

export async function savePosterFromUrl(directory: string, url: string): Promise<boolean> {
  try {
    const response = await guardedFetch(url, { signal: AbortSignal.timeout(20_000) });
    if (!response.ok) return false;
    const type = response.headers.get("content-type") ?? "";
    if (!type.startsWith("image/")) return false;
    const data = Buffer.from(await response.arrayBuffer());
    if (!data.length || data.length > 8 * 1024 * 1024) return false;
    await writeAtomic(path.join(directory, POSTER_OUTPUT), data);
    return true;
  } catch { return false; }
}

/**
 * A frame from the video. The thumbnail filter picks a representative picture out of fifty,
 * which costs practically the same as one blind grab but does not return a black rectangle.
 */
export async function saveFrame(videoPath: string, target: string, seconds = 300): Promise<boolean> {
  const temp = `${target}.tmp.jpg`;
  try {
    await run("ffmpeg", [
      "-hide_banner", "-loglevel", "error", "-nostdin",
      "-ss", String(seconds), "-i", videoPath,
      "-vf", "thumbnail=50,scale=480:-2", "-frames:v", "1", "-q:v", "4", "-y", temp,
    ], { timeout: 60_000 });
    await rename(temp, target);
    return true;
  } catch (error) {
    log("WARN", "The thumbnail could not be generated", { file: path.basename(videoPath), reason: error instanceof Error ? error.message.slice(0, 120) : String(error) });
    return false;
  }
}

/** Short videos have no fifth minute; roughly a third of the running time is taken instead. */
export const framePosition = (duration?: number) => {
  if (!duration || !Number.isFinite(duration) || duration <= 0) return 300;
  return Math.max(1, Math.min(300, Math.floor(duration / 3)));
};

/** One run at a time. On a Celeron, making thumbnails is the most expensive thing the server does. */
export class ArtworkQueue {
  private pending = new Set<string>();
  private chain: Promise<void> = Promise.resolve();

  /** Whether a job for this key is already queued or running. */
  has(key: string) { return this.pending.has(key); }

  run(key: string, task: () => Promise<void>) {
    this.pending.add(key);
    this.chain = this.chain
      .then(task)
      .catch((error) => log("WARN", "The artwork job failed", { key, reason: String(error).slice(0, 120) }))
      .finally(() => { this.pending.delete(key); });
    return this.chain;
  }
  get size() { return this.pending.size; }
}
