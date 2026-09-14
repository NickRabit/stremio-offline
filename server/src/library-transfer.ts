import { createReadStream, createWriteStream } from "node:fs";
import { lstat, mkdir, open, readdir, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";

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

export async function transferLibraryPath(source: string, target: string, move: boolean, report: TransferProgress = () => undefined) {
  const [sourceInfo, parentInfo] = await Promise.all([stat(source), stat(path.dirname(target))]);
  if (move && sourceInfo.dev === parentInfo.dev) {
    await rename(source, target);
    const bytes = sourceInfo.isFile() ? sourceInfo.size : 0;
    report(bytes, bytes);
    return { bytes, total: bytes };
  }
  const total = await byteSize(source);
  const temporary = `${target}.part`;
  await rm(temporary, { recursive: true, force: true });
  const progress = { bytes: 0, total, report };
  try {
    await copyTree(source, temporary, progress);
    await rename(temporary, target);
    if (move) await rm(source, { recursive: true, force: false });
  } catch (error) {
    await rm(temporary, { recursive: true, force: true });
    throw error;
  }
  report(total, total);
  return { bytes: total, total };
}
