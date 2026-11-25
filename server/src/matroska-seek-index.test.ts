import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { applyPatch, cuesPointerPatch, type HeadPatch } from "./matroska-seek-index.js";

const here = path.dirname(fileURLToPath(import.meta.url));
/** Built from one FFmpeg file: `cues-pointed` as FFmpeg wrote it, `cues-behind-second-seekhead`
 *  rewritten into mkvmerge's layout (the front SeekHead lists only a second SeekHead at the end,
 *  which lists the Cues), `.served` that file as the server must serve it. The Android TV test
 *  MatroskaSeekIndexTest runs the player's extractor over the same three. */
const fixture = (name: string) => readFileSync(path.join(here, "..", "test-fixtures", "matroska", name));

const reader = (file: Buffer) => async (position: number, length: number) => file.subarray(position, position + length);
const patchOf = (file: Buffer) => cuesPointerPatch(reader(file), file.length);
const served = (file: Buffer, patch: HeadPatch) => applyPatch(Buffer.from(file), 0, patch);

const hex = (value: string) => Buffer.from(value, "hex");
const size = (length: number) => {
  if (length < 127) return Buffer.from([0x80 | length]);
  return Buffer.from([0x40 | (length >> 8), length & 0xff]);
};
const el = (id: string, ...content: Buffer[]) => { const body = Buffer.concat(content); return Buffer.concat([hex(id), size(body.length), body]); };
const uint = (value: number) => { const bytes = Buffer.alloc(4); bytes.writeUInt32BE(value); return bytes; };
const seekHead = (id: string, position: number) => el("114d9b74", el("4dbb", el("53ab", hex(id)), el("53ac", uint(position))));
const voidOf = (length: number) => length < 129 ? Buffer.concat([hex("ec"), size(length - 2), Buffer.alloc(length - 2)]) : Buffer.concat([hex("ec"), size(length - 3), Buffer.alloc(length - 3)]);

/** A Segment shaped the way mkvmerge writes it, small enough to read by eye. */
const film = (options: { voidLength?: number; cuesBeforeCluster?: boolean; secondaryPointsAtCues?: boolean; cuesListedInFront?: boolean } = {}) => {
  const { voidLength = 41, cuesBeforeCluster = false, secondaryPointsAtCues = true, cuesListedInFront = false } = options;
  const ebml = el("1a45dfa3", el("4282", Buffer.from("matroska")));
  const info = el("1549a966", el("2ad7b1", hex("0f4240")));
  const cluster = el("1f43b675", el("e7", hex("00")), Buffer.alloc(200, 7));
  const cues = el("1c53bb6b", el("bb", el("b3", hex("00")), el("b7", el("f7", hex("01")), el("f1", hex("00")))));
  const frontLength = seekHead("114d9b74", 0).length;
  const voidPart = voidLength ? voidOf(voidLength) : Buffer.alloc(0);
  const before = (cuesBeforeCluster ? [info, cues] : [info]);
  const prefix = frontLength + voidPart.length + before.reduce((total, part) => total + part.length, 0);
  const cuesAt = cuesBeforeCluster ? prefix - cues.length : prefix + cluster.length;
  const secondaryAt = cuesBeforeCluster ? prefix + cluster.length : cuesAt + cues.length;
  const front = cuesListedInFront ? seekHead("1c53bb6b", cuesAt) : seekHead("114d9b74", secondaryAt);
  const secondary = seekHead(secondaryPointsAtCues ? "1c53bb6b" : "1549a966", secondaryPointsAtCues ? cuesAt : 0);
  const body = Buffer.concat([front, voidPart, ...before, cluster, ...(cuesBeforeCluster ? [] : [cues]), secondary]);
  const segment = Buffer.concat([hex("18538067"), hex("01"), Buffer.from([0, 0, 0, 0, 0, 0, 0]), body]);
  segment.writeUIntBE(body.length, 6, 6);
  const segmentData = ebml.length + 12;
  return { file: Buffer.concat([ebml, segment]), cuesAt, segmentData, voidAt: segmentData + front.length };
};

test("the mkvmerge layout is served with a SeekHead that names the Cues, byte for byte", async () => {
  const file = fixture("cues-behind-second-seekhead.mkv");
  const patch = await patchOf(file);
  assert.ok(patch, "the Cues behind the second SeekHead are found");
  assert.deepEqual(served(file, patch), fixture("cues-behind-second-seekhead.served.mkv"));
});

test("a file whose front SeekHead already names the Cues is left alone", async () => {
  assert.equal(await patchOf(fixture("cues-pointed.mkv")), undefined);
  assert.equal(await patchOf(film({ cuesListedInFront: true }).file), undefined);
});

test("the patch takes the place of the Void and nothing else", async () => {
  const { file, cuesAt, voidAt } = film();
  const patch = await patchOf(file);
  assert.ok(patch);
  assert.equal(patch.offset, voidAt);
  assert.equal(patch.bytes.length, 41);
  assert.equal(patch.cues, cuesAt);
  const after = served(file, patch);
  assert.deepEqual(after.subarray(0, voidAt), file.subarray(0, voidAt));
  assert.deepEqual(after.subarray(voidAt + 41), file.subarray(voidAt + 41));
  assert.equal(after.subarray(voidAt, voidAt + 4).toString("hex"), "114d9b74");
  assert.equal(await patchOf(after), undefined, "the served bytes need no second patch");
});

test("a Void that leaves one spare byte widens the SeekHead's size instead", async () => {
  const exact = await patchOf(film({ voidLength: 26 }).file);
  assert.equal(exact?.bytes.length, 26);
  const widened = await patchOf(film({ voidLength: 27 }).file);
  assert.equal(widened?.bytes.length, 27);
  assert.equal(widened.bytes.subarray(4, 6).toString("hex"), "4015", "a two-byte size of 21");
  const { file } = film({ voidLength: 27 });
  assert.equal(await patchOf(served(file, widened)), undefined, "the widened SeekHead is read as one");
});

test("no patch without room, without Cues, or with Cues the player meets anyway", async () => {
  assert.equal(await patchOf(film({ voidLength: 25 }).file), undefined, "a Void too small");
  assert.equal(await patchOf(film({ voidLength: 0 }).file), undefined, "no Void at all");
  assert.equal(await patchOf(film({ secondaryPointsAtCues: false }).file), undefined, "no Cues listed anywhere");
  assert.equal(await patchOf(film({ cuesBeforeCluster: true }).file), undefined, "Cues read before the first Cluster");
});

test("a second SeekHead pointing at something that is not Cues is not trusted", async () => {
  const { file, cuesAt, segmentData } = film();
  const broken = Buffer.from(file);
  broken.writeUInt32BE(0, segmentData + cuesAt);
  assert.equal(await patchOf(broken), undefined);
});

test("what is not a whole Matroska file is never patched and never throws", async () => {
  const { file } = film();
  assert.equal(await patchOf(Buffer.from("....ftypisom and the rest of an MP4")), undefined);
  assert.equal(await patchOf(Buffer.alloc(0)), undefined);
  for (const length of [3, 20, 60, file.length - 30]) {
    assert.equal(await patchOf(file.subarray(0, length)), undefined, `cut at ${length}`);
  }
});

test("a chunk is patched only where it overlaps the patch", () => {
  const patch: HeadPatch = { offset: 10, bytes: Buffer.from([1, 2, 3, 4]), cues: 0 };
  assert.deepEqual([...applyPatch(Buffer.alloc(6), 8, patch)], [0, 0, 1, 2, 3, 4]);
  assert.deepEqual([...applyPatch(Buffer.alloc(3), 12, patch)], [3, 4, 0]);
  assert.deepEqual([...applyPatch(Buffer.alloc(2), 11, patch)], [2, 3]);
  assert.deepEqual([...applyPatch(Buffer.alloc(4), 14, patch)], [0, 0, 0, 0]);
  assert.deepEqual([...applyPatch(Buffer.alloc(4), 0, patch)], [0, 0, 0, 0]);
});
