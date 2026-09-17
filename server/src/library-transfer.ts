import { createReadStream, createWriteStream } from "node:fs";
import { lstat, mkdir, open, readdir, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
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
 *  the caller copies instead. Asking `stat` first would only be a guess -- two bind mounts
 *  of one host directory share a device number under Docker Desktop and still refuse the
 *  rename, while two btrfs subvolumes of one NAS volume carry different ones. The kernel
 *  knows, and a refused rename costs a syscall, so the move is simply tried. */
export async function renameAcross(source: string, target: string): Promise<boolean> {
  try {
    await rename(source, target);
    return true;
  } catch (error) {
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
    const bytes = sourceInfo.isDirectory() ? await byteSize(target) : sourceInfo.size;
    report(bytes, bytes);
    return { bytes, total: bytes };
  }
  const total = await byteSize(source);
  const temporary = `${target}.part`;
  await rm(temporary, { recursive: true, force: true });
  const progress = { bytes: 0, total, report };
  try {
    await copyTree(source, temporary, progress);
  } catch (error) {
    await rm(temporary, { recursive: true, force: true });
    throw error;
  }
  // Past this point the copy is durable and in place. A failure now is about the source
  // that is left behind, not about the transfer: throwing would report a move that did
  // not happen, and the retry would only meet its own result as `err.nameTaken`.
  await rename(temporary, target);
  const sourceLeft = move ? await removeMovedSource(source) : undefined;
  report(total, total);
  return { bytes: total, total, ...(sourceLeft ? { sourceLeft } : {}) };
}
