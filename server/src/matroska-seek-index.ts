import { open, stat } from "node:fs/promises";
import path from "node:path";
import { log } from "./logger.js";

/**
 * Media3's Matroska extractor (the Android TV player) learns where the Cues are only from a
 * SeekHead it meets before the first Cluster, and does not follow a SeekHead entry that points
 * at a second SeekHead. mkvmerge writes exactly that when the front SeekHead has no room: the
 * front one points at a SeekHead at the end of the file, which points at the Cues. The player
 * then marks the film unseekable and every seek lands on 0:00. FFmpeg follows the second
 * SeekHead, so only direct play on the TV is hit.
 *
 * The fix leaves the file alone: a Void before the first Cluster is served as a SeekHead that
 * points straight at the Cues. A Void is padding by definition, so no other byte moves.
 */

const ID_EBML = 0x1a45dfa3;
const ID_SEGMENT = 0x18538067;
const ID_SEEK_HEAD = 0x114d9b74;
const ID_SEEK = 0x4dbb;
const ID_SEEK_ID = 0x53ab;
const ID_SEEK_POSITION = 0x53ac;
const ID_CUES = 0x1c53bb6b;
const ID_CLUSTER = 0x1f43b675;
const ID_VOID = 0xec;

/** Level-1 elements read before giving up on finding the first Cluster. */
const MAX_LEVEL1 = 256;
/** A SeekHead is a few dozen bytes; anything far larger is not one worth trusting. */
const MAX_SEEK_HEAD = 64 * 1024;
const MAX_SECONDARY = 4;

export type ByteReader = (position: number, length: number) => Promise<Buffer>;

/** Bytes that replace the file's own at `offset` when it is served. */
export interface HeadPatch {
  offset: number;
  bytes: Buffer;
  /** Where the Cues start, relative to the Segment's data. */
  cues: number;
}

interface Vint { value: number; length: number; unknown: boolean }

const readVint = (buffer: Buffer, offset: number, keepMarker: boolean): Vint | undefined => {
  if (offset >= buffer.length) return undefined;
  const first = buffer[offset];
  let length = 1;
  while (length <= 8 && !(first & (0x80 >> (length - 1)))) length += 1;
  if (length > 8 || offset + length > buffer.length) return undefined;
  const mask = 0xff >> length;
  let value = keepMarker ? first : first & mask;
  let unknown = (first & mask) === mask;
  for (let index = 1; index < length; index += 1) {
    value = value * 256 + buffer[offset + index];
    if (buffer[offset + index] !== 0xff) unknown = false;
  }
  return { value, length, unknown: !keepMarker && unknown };
};

interface Element { id: number; start: number; dataStart: number; size: number | undefined; end: number | undefined }

const readElement = async (read: ByteReader, position: number): Promise<Element | undefined> => {
  const head = await read(position, 12);
  const id = readVint(head, 0, true);
  if (!id || id.length > 4) return undefined;
  const size = readVint(head, id.length, false);
  if (!size) return undefined;
  const dataStart = position + id.length + size.length;
  const known = size.unknown ? undefined : size.value;
  return { id: id.value, start: position, dataStart, size: known, end: known === undefined ? undefined : dataStart + known };
};

/** The children of a master element whose bytes are all in `buffer`. */
const children = (buffer: Buffer) => {
  const found: Array<{ id: number; data: Buffer }> = [];
  let offset = 0;
  while (offset < buffer.length) {
    const id = readVint(buffer, offset, true);
    const size = id && readVint(buffer, offset + id.length, false);
    if (!id || !size || size.unknown) break;
    const dataStart = offset + id.length + size.length;
    if (dataStart + size.value > buffer.length) break;
    found.push({ id: id.value, data: buffer.subarray(dataStart, dataStart + size.value) });
    offset = dataStart + size.value;
  }
  return found;
};

const unsigned = (data: Buffer) => {
  if (data.length < 1 || data.length > 8) return undefined;
  const value = data.reduce((total, byte) => total * 256 + byte, 0);
  return Number.isSafeInteger(value) ? value : undefined;
};

/** The entries of one SeekHead: which element sits where, relative to the Segment's data. */
const seekEntries = (content: Buffer) => children(content)
  .filter((child) => child.id === ID_SEEK)
  .map((seek) => {
    const fields = children(seek.data);
    const id = fields.find((field) => field.id === ID_SEEK_ID)?.data;
    const position = fields.find((field) => field.id === ID_SEEK_POSITION)?.data;
    return { id: id && id.length <= 4 ? unsigned(id) : undefined, position: position ? unsigned(position) : undefined };
  })
  .filter((entry): entry is { id: number; position: number } => entry.id !== undefined && entry.position !== undefined);

const vint = (value: number, width: number) => {
  const bytes = Buffer.alloc(width);
  let rest = value;
  for (let index = width - 1; index >= 0; index -= 1) { bytes[index] = rest % 256; rest = Math.floor(rest / 256); }
  bytes[0] |= 0x80 >> (width - 1);
  return bytes;
};

const idBytes = (id: number) => {
  const width = id > 0xffffff ? 4 : id > 0xffff ? 3 : id > 0xff ? 2 : 1;
  const bytes = Buffer.alloc(width);
  bytes.writeUIntBE(id, 0, width);
  return bytes;
};

const element = (id: number, content: Buffer, sizeWidth = 1) => Buffer.concat([idBytes(id), vint(content.length, sizeWidth), content]);

/** A SeekHead with a single entry: the Cues at `cues`. Its size field may be widened by one byte
 *  so that what is left of the Void is never the single byte no element fits in. */
const cuesSeekHead = (cues: number, sizeWidth: number) => {
  const position = Buffer.alloc(8);
  position.writeBigUInt64BE(BigInt(cues));
  const seek = element(ID_SEEK, Buffer.concat([element(ID_SEEK_ID, idBytes(ID_CUES)), element(ID_SEEK_POSITION, position)]));
  return element(ID_SEEK_HEAD, seek, sizeWidth);
};

/** The header of a Void exactly `length` bytes long (at least two). Its content is whatever the
 *  file already holds there: a Void's bytes mean nothing, so a large one is never copied. */
const voidHeader = (length: number) => {
  for (let width = 1; width <= 8; width += 1) {
    const content = length - 1 - width;
    if (content >= 0 && content < 2 ** (7 * width) - 1) return Buffer.concat([idBytes(ID_VOID), vint(content, width)]);
  }
  return undefined;
};

/** The bytes to serve in place of a Void so the player finds the Cues; nothing when it can
 *  already find them, when there are none, or when there is no room. */
export async function cuesPointerPatch(read: ByteReader, size: number): Promise<HeadPatch | undefined> {
  const ebml = await readElement(read, 0);
  if (!ebml || ebml.id !== ID_EBML || ebml.end === undefined) return undefined;
  const segment = await readElement(read, ebml.end);
  if (!segment || segment.id !== ID_SEGMENT) return undefined;
  const segmentData = segment.dataStart;
  const segmentEnd = segment.end === undefined ? size : Math.min(segment.end, size);

  const entries: Array<{ id: number; position: number }> = [];
  const voids: Array<{ start: number; length: number }> = [];
  let position = segmentData;
  let reachedCluster = false;
  for (let count = 0; count < MAX_LEVEL1 && position < segmentEnd; count += 1) {
    const found = await readElement(read, position);
    if (!found) return undefined;
    if (found.id === ID_CLUSTER) { reachedCluster = true; break; }
    // Cues before the first Cluster are read in passing; the player needs no pointer.
    if (found.id === ID_CUES || found.end === undefined || found.end > segmentEnd) return undefined;
    if (found.id === ID_SEEK_HEAD) {
      if (found.size! > MAX_SEEK_HEAD) return undefined;
      entries.push(...seekEntries(await read(found.dataStart, found.size!)));
    } else if (found.id === ID_VOID) {
      voids.push({ start: found.start, length: found.end - found.start });
    }
    position = found.end;
  }
  if (!reachedCluster || entries.some((entry) => entry.id === ID_CUES)) return undefined;

  let cues: number | undefined;
  for (const entry of entries.filter((item) => item.id === ID_SEEK_HEAD).slice(0, MAX_SECONDARY)) {
    const secondary = await readElement(read, segmentData + entry.position);
    if (!secondary || secondary.id !== ID_SEEK_HEAD || secondary.size === undefined || secondary.size > MAX_SEEK_HEAD) continue;
    if (secondary.end! > segmentEnd) continue;
    cues = seekEntries(await read(secondary.dataStart, secondary.size)).find((item) => item.id === ID_CUES)?.position;
    if (cues !== undefined) break;
  }
  if (cues === undefined) return undefined;
  const target = await readElement(read, segmentData + cues);
  if (!target || target.id !== ID_CUES || target.end === undefined || target.end > segmentEnd) return undefined;

  const shortest = cuesSeekHead(cues, 1).length;
  const room = voids.find((item) => item.length >= shortest);
  if (!room) return undefined;
  const rest = room.length - shortest;
  if (rest <= 1) return { offset: room.start, bytes: cuesSeekHead(cues, 1 + rest), cues };
  const filler = voidHeader(rest);
  if (!filler) return undefined;
  return { offset: room.start, bytes: Buffer.concat([cuesSeekHead(cues, 1), filler]), cues };
}

/** Lays the patch over `chunk`, which holds the file's bytes from `chunkStart`. */
export function applyPatch(chunk: Buffer, chunkStart: number, patch: HeadPatch) {
  const from = Math.max(chunkStart, patch.offset);
  const to = Math.min(chunkStart + chunk.length, patch.offset + patch.bytes.length);
  if (from < to) patch.bytes.copy(chunk, from - chunkStart, from - patch.offset, to - patch.offset);
  return chunk;
}

export interface PatchedFile { size: number; mtime: Date; patch: HeadPatch }

const fileReader = (handle: Awaited<ReturnType<typeof open>>, size: number): ByteReader => async (position, length) => {
  const bytes = Buffer.alloc(Math.max(0, Math.min(length, size - position)));
  if (!bytes.length) return bytes;
  const { bytesRead } = await handle.read(bytes, 0, bytes.length, position);
  return bytes.subarray(0, bytesRead);
};

/** Library files whose Cues the player cannot reach, remembered per file version so each is
 *  read only once. A file that needs nothing is remembered too; a read that failed is not. */
export class SeekIndexPatches {
  private readonly known = new Map<string, Promise<HeadPatch | undefined>>();

  constructor(private readonly limit = 256) {}

  async patched(file: string): Promise<PatchedFile | undefined> {
    const info = await stat(file);
    if (!info.isFile()) return undefined;
    const key = `${file}\0${info.size}\0${info.mtimeMs}\0${info.ino}`;
    let pending = this.known.get(key);
    if (!pending) {
      const inspecting = this.inspect(file, info.size).catch(() => {
        if (this.known.get(key) === inspecting) this.known.delete(key);
        return undefined;
      });
      pending = inspecting;
      if (this.known.size >= this.limit) this.known.delete(this.known.keys().next().value!);
      this.known.set(key, pending);
    }
    const patch = await pending;
    return patch ? { size: info.size, mtime: info.mtime, patch } : undefined;
  }

  private async inspect(file: string, size: number) {
    const handle = await open(file, "r");
    try {
      const patch = await cuesPointerPatch(fileReader(handle, size), size);
      if (patch) log("INFO", "Matroska seek index pointed to for the player", { file: path.basename(file), cues: patch.cues });
      return patch;
    } finally { await handle.close(); }
  }
}

export type OpenFile = Awaited<ReturnType<typeof open>>;

/** The bytes `start`..`end` (inclusive) of an open file with the patch laid over them. The
 *  handle is closed when the range ends or its reader stops early. */
export async function* patchedRange(handle: OpenFile, start: number, end: number, patch: HeadPatch, highWaterMark: number) {
  let streaming = false;
  try {
    let position = start;
    const patchEnd = patch.offset + patch.bytes.length;
    if (position < patchEnd) {
      const until = Math.min(end + 1, patchEnd);
      const head = Buffer.alloc(until - position);
      const { bytesRead } = await handle.read(head, 0, head.length, position);
      if (bytesRead !== head.length) throw new Error("The file is shorter than it was.");
      yield applyPatch(head, position, patch);
      position = until;
    }
    if (position <= end) {
      streaming = true;
      yield* handle.createReadStream({ start: position, end, highWaterMark, autoClose: true });
    }
  } finally {
    if (!streaming) await handle.close();
  }
}
