import { createReadStream, createWriteStream } from "node:fs";
import { randomBytes } from "node:crypto";
import { lstat, mkdir, open, readdir, rename, rmdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { AppError } from "./errors.js";
import { log } from "./logger.js";

export type TransferProgress = (bytes: number, total: number) => void;

const byteSize = async (source: string): Promise<number> => {
  const info = await lstat(source);
  if (info.isSymbolicLink()) throw new Error("Symbolic links cannot be copied.");
  if (!info.isDirectory()) return info.size;
  const entries = await readdir(source, { withFileTypes: true });
  return (await Promise.all(entries.map((entry) => byteSize(path.join(source, entry.name))))).reduce((sum, value) => sum + value, 0);
};

const syncFile = async (file: string) => {
  const handle = await open(file, "r");
  try { await handle.sync(); } finally { await handle.close(); }
};

const copyTree = async (source: string, target: string, progress: { bytes: number; total: number; report: TransferProgress }) => {
  const info = await lstat(source);
  if (info.isSymbolicLink()) throw new Error("Symbolic links cannot be copied.");
  if (info.isDirectory()) {
    await mkdir(target, { recursive: true });
    const entries = await readdir(source, { withFileTypes: true });
    for (const entry of entries) await copyTree(path.join(source, entry.name), path.join(target, entry.name), progress);
    return;
  }
  await mkdir(path.dirname(target), { recursive: true });
  const input = createReadStream(source);
  input.on("data", (chunk) => {
    progress.bytes += typeof chunk === "string" ? Buffer.byteLength(chunk) : chunk.byteLength;
    progress.report(progress.bytes, progress.total);
  });
  await pipeline(input, createWriteStream(target, { mode: info.mode }));
  await syncFile(target);
};

const exists = (candidate: string) => lstat(candidate).then(() => true, () => false);

/** A staging path beside the target, so the final `rename` stays on the destination's
 *  filesystem, carrying a per-call random suffix of its own. `${target}.part` is the
 *  download queue's in-flight name: taking it, or clearing it, would destroy a download
 *  that is running -- or a partial left by one that crashed. The candidate is only handed
 *  out once it is known to be free, so a copy removes nothing but what it created. */
const stagingPath = async (target: string): Promise<string> => {
  for (let attempt = 0; attempt < 16; attempt += 1) {
    const candidate = `${target}.${randomBytes(8).toString("hex")}.part`;
    if (!await exists(candidate)) return candidate;
  }
  throw new Error(`No free staging name is available next to ${target}.`);
};

/** The same refusal the caller raises before the copy, so a name lost to another transfer
 *  reads as a taken name and not as an internal failure. */
const nameTaken = () => new AppError("A file with that name already exists.", "err.nameTaken");

/** Takes the target's name with an atomic create, because `rename` on its own replaces whatever
 *  is there without a word. A file is reserved with `O_CREAT | O_EXCL` and a folder with `mkdir`;
 *  the swap then renames the staged item over either empty placeholder. */
const reserveTarget = async (target: string, directory: boolean): Promise<void> => {
  try {
    if (directory) await mkdir(target);
    else await (await open(target, "wx")).close();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") throw nameTaken();
    throw error;
  }
};

/** Drops a reservation whose rename never landed. A folder goes through `rmdir`, which refuses
 *  a folder that gained content, so only the empty placeholder this call made can be removed. */
const releaseTarget = async (target: string, directory: boolean): Promise<void> => {
  try {
    if (directory) await rmdir(target);
    else await rm(target, { force: true });
  } catch (error) {
    log("WARN", "A reserved destination could not be released", {
      target, reason: (error instanceof Error ? error.message : String(error)).slice(0, 120),
    });
  }
};

/** Publishes the staged copy at a name only this call may take. A second transfer into the same
 *  name loses the reservation and is refused there: it never reaches the rename, so it cannot
 *  overwrite what the winner put in place. */
const publish = async (temporary: string, target: string, directory: boolean): Promise<void> => {
  await reserveTarget(target, directory);
  try {
    await rename(temporary, target);
  } catch (error) {
    await releaseTarget(target, directory);
    throw error;
  }
};

/** Drops the source of a finished move. The copy is already at the destination, so a
 *  refusal here leaves a duplicate, not a lost item: it is reported, never thrown. The
 *  message comes back for the caller to log and show; `undefined` means the source is gone. */
export async function removeMovedSource(source: string): Promise<string | undefined> {
  try {
    await rm(source, { recursive: true, force: false });
    return undefined;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    log("WARN", "The copy landed but the source could not be removed", { source, reason: reason.slice(0, 120) });
    return reason;
  }
}

export interface TransferResult {
  bytes: number;
  total: number;
  /** A move whose copy landed but whose source could not be removed. The item is at the
   *  destination and also still where it was; the caller reports the leftover instead of
   *  calling the whole transfer a failure. */
  sourceLeft?: string;
}

/** Moves the item in one step when the filesystem allows it. `false` means it does not:
 *  the caller copies instead. Asking for the device first would only be a guess -- two bind
 *  mounts of one host directory share a device number under Docker Desktop and still refuse
 *  the rename, while two btrfs subvolumes of one NAS volume carry different ones. The kernel
 *  knows, and a refused rename costs a syscall, so the move is simply tried.
 *
 *  The destination is reserved first, the same way a staged copy reserves it, because a bare
 *  rename would quietly replace a name another move has already taken -- and here the loser
 *  would lose its source as well. The item's own kind picks the placeholder: a folder can only
 *  be renamed over an empty folder. */
export async function renameAcross(source: string, target: string): Promise<boolean> {
  const directory = (await lstat(source)).isDirectory();
  await reserveTarget(target, directory);
  try {
    await rename(source, target);
    return true;
  } catch (error) {
    // The rename never landed, so the placeholder is still this call's to drop. It has to go
    // before the fallback: the copy that follows would otherwise meet it and refuse itself.
    await releaseTarget(target, directory);
    if ((error as NodeJS.ErrnoException).code !== "EXDEV") throw error;
    log("INFO", "The move crosses a filesystem, copying instead", { source, target });
    return false;
  }
}

export async function transferLibraryPath(source: string, target: string, move: boolean, report: TransferProgress = () => undefined): Promise<TransferResult> {
  // The destination's parent is stat'd, not for its device -- that is the kernel's to know --
  // but because a transfer into a folder that is not there is a mistake, not a folder to create.
  const [sourceInfo] = await Promise.all([stat(source), stat(path.dirname(target))]);
  if (move && await renameAcross(source, target)) {
    // A folder is renamed whole, so nothing was copied -- but the size is what the item
    // takes, and a progress bar that reads zero for a moved season is a lie about the item.
    // Measuring walks the tree that has just moved, and refuses a symlink the rename itself
    // accepted: the item is already at the destination, so a measurement that fails falls
    // back to the size `stat` gave instead of reporting a move that happened as a failure.
    const bytes = sourceInfo.isDirectory() ? await byteSize(target).catch((error: unknown) => {
      log("WARN", "The size of the moved item could not be measured", {
        target, reason: (error instanceof Error ? error.message : String(error)).slice(0, 120),
      });
      return sourceInfo.size;
    }) : sourceInfo.size;
    report(bytes, bytes);
    return { bytes, total: bytes };
  }
  // The copy path refuses a tree holding a symlink before it writes anything: this `byteSize`
  // is that pre-flight check, and its throw is deliberate.
  const total = await byteSize(source);
  const temporary = await stagingPath(target);
  const progress = { bytes: 0, total, report };
  try {
    await copyTree(source, temporary, progress);
    await publish(temporary, target, sourceInfo.isDirectory());
  } catch (error) {
    // Only the staging path this call reserved is cleared; the item itself stays where it was.
    await rm(temporary, { recursive: true, force: true });
    throw error;
  }
  // Past this point the copy is durable and in place. A failure now is about the source
  // that is left behind, not about the transfer: throwing would report a move that did
  // not happen, and the retry would only meet its own result as `err.nameTaken`.
  const sourceLeft = move ? await removeMovedSource(source) : undefined;
  report(total, total);
  return { bytes: total, total, ...(sourceLeft ? { sourceLeft } : {}) };
}
