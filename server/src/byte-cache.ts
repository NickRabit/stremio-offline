import { readFile, stat } from "node:fs/promises";
import { log } from "./logger.js";

/** A weak validator of one file's identity: the size and mtime its bytes were read at. */
export function fileEtag(size: number, mtimeMs: number): string {
  return `W/"${size.toString(16)}-${mtimeMs.toString(16)}"`;
}

/** HTTP's weak comparison for an If-None-Match list, including `*`. */
export function etagMatches(header: string | string[] | undefined, etag: string): boolean {
  const value = Array.isArray(header) ? header.join(",") : header;
  if (!value) return false;
  const weak = (tag: string) => tag.trim().replace(/^W\//, "");
  const wanted = weak(etag);
  return value.split(",").some((tag) => tag.trim() === "*" || weak(tag) === wanted);
}

export interface FileSnap {
  bytes: Buffer;
  etag: string;
  size: number;
  mtimeMs: number;
}

/** `THUMB_MEMORY_MB`: an explicit `0` turns the layer off, anything else unusable is 32 MiB. */
const snapMemoryBytes = (value: string | undefined = process.env.THUMB_MEMORY_MB): number => {
  const text = value?.trim();
  const parsed = Number(text);
  return (!text || !Number.isFinite(parsed) || parsed < 0 ? 32 : parsed) * 1024 * 1024;
};

/** The whole bytes of a file the server serves as-is, kept in memory in front of the disk. A
 *  hit never stats or reads: the snapshot already carries the bytes and their validator. */
export class FileSnapCache {
  private entries = new Map<string, FileSnap>();
  private bytes = 0;

  constructor(readonly cap: number = snapMemoryBytes()) {}

  get byteSize(): number { return this.bytes; }

  has(file: string): boolean { return this.entries.has(file); }

  /** The snap, if it is here. Recency is the map order, so a hit moves its entry to the end. */
  get(file: string): FileSnap | undefined {
    const snap = this.entries.get(file);
    if (!snap) return undefined;
    this.entries.delete(file);
    this.entries.set(file, snap);
    return snap;
  }

  put(file: string, snap: FileSnap): void {
    if (this.cap <= 0 || snap.bytes.length > this.cap) return;
    const known = this.entries.get(file);
    if (known) {
      this.entries.delete(file);
      this.bytes -= known.bytes.length;
    }
    while (this.bytes + snap.bytes.length > this.cap) {
      const oldest = this.entries.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      const dropped = this.entries.get(oldest)!;
      this.entries.delete(oldest);
      this.bytes -= dropped.bytes.length;
    }
    this.entries.set(file, snap);
    this.bytes += snap.bytes.length;
  }
}

/** Fills the memory with the hottest files that still fit, in the background. A file bigger
 *  than the whole cap is skipped, and the first one that does not fit ends the walk. */
export async function preheatFileSnaps(
  cache: FileSnapCache,
  files: Array<{ file: string; at: number }>,
): Promise<void> {
  if (cache.cap <= 0) return;
  const ordered = [...files].sort((left, right) => right.at - left.at);
  const warmed: string[] = [];
  let count = 0;
  let bytes = 0;
  for (const entry of ordered) {
    if (cache.has(entry.file)) continue;
    const info = await stat(entry.file).catch(() => undefined);
    if (!info?.isFile()) continue;
    if (info.size > cache.cap) continue;
    if (info.size > cache.cap - cache.byteSize) break;
    const data = await readFile(entry.file).catch(() => undefined);
    if (!data) continue;
    cache.put(entry.file, { bytes: data, etag: fileEtag(info.size, info.mtime.getTime()), size: info.size, mtimeMs: info.mtime.getTime() });
    warmed.push(entry.file);
    count += 1;
    bytes += data.length;
  }
  // The walk inserts the newest first, which would make it the first one evicted. Touching
  // oldest-first leaves the hottest file as the most recent.
  for (const file of warmed.reverse()) cache.get(file);
  log("INFO", "Artwork thumb preheat finished", { files: count, bytes });
}
