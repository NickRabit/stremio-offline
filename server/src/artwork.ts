import { execFile } from "node:child_process";
import { access, readdir, rename, rm, writeFile } from "node:fs/promises";
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
/** The same for the wide variant: the first name Emby and Jellyfin read for a backdrop. */
export const BACKDROP_OUTPUT = "backdrop.jpg";

/** The two pictures a title keeps: the portrait poster and the landscape backdrop. The
 *  spelling matches the interface's tile shape. */
export type ArtShape = "poster" | "wide";

export const artNames = (shape: ArtShape) => shape === "wide" ? BACKDROP_NAMES : POSTER_NAMES;
export const artOutput = (shape: ArtShape) => shape === "wide" ? BACKDROP_OUTPUT : POSTER_OUTPUT;

/** The key a shape's variant holds in the generated-artwork store: a second sha1 in the same
 *  directory, so it inherits the byte accounting and the eviction of `artwork-cache.ts`. The
 *  poster keeps the key it has always had, so no file on disk is renamed by the second one. */
export const artVariantKey = (key: string, shape: ArtShape) => shape === "wide" ? `${key}#wide` : key;

/** A generated poster lands next to the media only where the library allows writing. A
 *  read-only root, a root that is away and a library the user keeps curated all fall back
 *  to `data/artwork/<libraryId>/`: dropping a file into somebody's archive is the one thing
 *  the switch must not do. */
export function artworkBesideMedia(
  library: Pick<LibraryRecord, "writeArtwork">,
  health: LibraryHealth,
): boolean {
  return library.writeArtwork && !health.readOnly && !health.unreachable;
}

/** Jellyfin looks for an episode thumbnail under the file name; we write the same. */
export const episodeArtName = (videoFile: string) => `${videoFile.replace(/\.[^.]+$/, "")}.jpg`;

/** A bound movie may reuse the folder poster when the folder **is** its folder. A series
 *  episode never inherits one, and a film sitting in a folder of unrelated videos must not
 *  wear that folder's picture either -- which is what a move into such a folder used to make
 *  it do.
 *
 *  Two ways to know the folder is the film's own, and the caller passes what it has:
 *  - `anchoredOn` is the key the binding that covers the file sits at, when the caller has the
 *    records (`knownTitleEntry`). The folder is the title's folder only when the binding is
 *    anchored on that very folder, not on the file itself.
 *  - without records, a film whose name is the folder's name is in a folder of its own: the
 *    `Practical Magic/Practical Magic.mkv` shape. This is a narrower test than the anchor, and
 *    it only ever adds the folder to a file that already carries its name. */
export function fileMayUseFolderArtwork(relative: string, titleType?: string, anchoredOn?: string): boolean {
  if (titleType !== "movie") return false;
  const parent = path.dirname(relative);
  if (parent === "." || parent === "") return false;
  if (anchoredOn !== undefined) return anchoredOn === parent || sharesFolderName(relative, parent);
  return sharesFolderName(relative, parent);
}

const sharesFolderName = (relative: string, parent: string) =>
  path.basename(relative, path.extname(relative)).normalize("NFC").toLowerCase()
  === path.basename(parent).normalize("NFC").toLowerCase();

const exists = async (file: string) => { try { await access(file); return true; } catch { return false; } };

/** A folder's names, lowercased for the lookup and mapped back to what is on disk.
 *  Read once and asked twice: a browse row wants a poster and a backdrop out of the
 *  same directory, and on a network mount the second listing is not free. */
export type FolderListing = Map<string, string>;

export async function readFolderListing(directory: string): Promise<FolderListing | undefined> {
  try { return new Map((await readdir(directory)).map((name) => [name.toLowerCase(), name])); }
  catch { return undefined; }
}

/** The first of `names` the folder holds, whoever produced it. The order is the priority. */
export function pickArtwork(listing: FolderListing | undefined, names: string[]): string | undefined {
  if (!listing) return undefined;
  for (const candidate of names) {
    const found = listing.get(candidate);
    if (found) return found;
  }
  return undefined;
}

/** Returns the name of an existing picture in the folder, whoever produced it. */
export async function findArtwork(directory: string, names = POSTER_NAMES): Promise<string | undefined> {
  return pickArtwork(await readFolderListing(directory), names);
}

/** Written through a temporary file, so half a picture never shows up. */
async function writeAtomic(target: string, data: Buffer) {
  const temp = `${target}.tmp`;
  await writeFile(temp, data, { mode: 0o644 });
  await rename(temp, target);
}

/** Why a picture did not arrive. Named rather than collapsed into `false`: a poster that never
 *  lands has to be distinguishable from one nobody asked for, or a blank title has no story. */
export type PosterOutcome =
  | { ok: true }
  | { ok: false; reason: "status" | "content-type" | "size" | "failed"; detail?: string };

type FetchOutcome = { ok: true; data: Buffer } | Extract<PosterOutcome, { ok: false }>;

const fetchPicture = async (url: string): Promise<FetchOutcome> => {
  try {
    const response = await guardedFetch(url, { signal: AbortSignal.timeout(20_000) });
    if (!response.ok) return { ok: false, reason: "status", detail: `${response.status}` };
    const type = response.headers.get("content-type") ?? "";
    if (!type.startsWith("image/")) return { ok: false, reason: "content-type", detail: type || "(none)" };
    const data = Buffer.from(await response.arrayBuffer());
    if (!data.length || data.length > 8 * 1024 * 1024) return { ok: false, reason: "size", detail: `${data.length}` };
    return { ok: true, data };
  } catch (error) {
    return { ok: false, reason: "failed", detail: error instanceof Error ? error.message : String(error) };
  }
};

/** Downloads a picture to an exact place. Used for the poster the client sent from the catalogue. */
export async function savePosterAs(target: string, url: string): Promise<PosterOutcome> {
  const fetched = await fetchPicture(url);
  if (!fetched.ok) return fetched;
  try {
    await writeAtomic(target, fetched.data);
    return { ok: true };
  } catch (error) {
    return { ok: false, reason: "failed", detail: error instanceof Error ? error.message : String(error) };
  }
}

/** The widest a stored backdrop may be. The catalogue hands out 200 kB - 1 MB backgrounds, and
 *  a second variant of every title at that weight would start evicting posters that are in use. */
const BACKDROP_WIDTH = 640;

/** Narrows a picture to a width cap. The filter is the one the image proxy uses for its tiles. */
async function shrinkToWidth(source: string, target: string, width: number): Promise<boolean> {
  const temp = `${target}.tmp.jpg`;
  try {
    await run("ffmpeg", [
      "-hide_banner", "-loglevel", "error", "-nostdin", "-threads", "1",
      "-i", source, "-vf", `scale='min(${width},iw)':-2`, "-frames:v", "1", "-q:v", "5", "-y", temp,
    ], { timeout: 15_000, killSignal: "SIGKILL" });
    await rename(temp, target);
    return true;
  } catch (error) {
    await rm(temp, { force: true });
    log("WARN", "The backdrop could not be narrowed", { reason: error instanceof Error ? error.message.slice(0, 120) : String(error) });
    return false;
  }
}

/** Downloads the wide variant of a catalogue picture and narrows it before it is stored. A
 *  picture ffmpeg could not read back is kept as it arrived: a large backdrop is worth more
 *  than a tile with no landscape picture at all. */
export async function saveBackdropAs(target: string, url: string): Promise<PosterOutcome> {
  const fetched = await fetchPicture(url);
  if (!fetched.ok) return fetched;
  const source = `${target}.src.jpg`;
  try {
    // The same mode a poster is written with, because the fallback below renames this very file.
    await writeFile(source, fetched.data, { mode: 0o644 });
    if (!await shrinkToWidth(source, target, BACKDROP_WIDTH)) await rename(source, target);
    return { ok: true };
  } catch (error) {
    return { ok: false, reason: "failed", detail: error instanceof Error ? error.message : String(error) };
  } finally {
    await rm(source, { force: true });
  }
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
