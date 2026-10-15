import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { composeMosaic, MosaicCache, mosaicCells, mosaicShape, MOSAIC_SIZES } from "./mosaic.js";
import { ffmpegPath } from "./media-tools.js";

const run = promisify(execFile);
const hasFfmpeg = await run(ffmpegPath(), ["-version"]).then(() => true, () => false);

test("a fan lays its pictures out inside the frame", () => {
  for (const shape of ["poster", "wide"] as const) {
    const { width, height } = MOSAIC_SIZES[shape];
    for (const count of [1, 2, 3, 4]) {
      const cells = mosaicCells(count, shape);
      assert.equal(cells.length, count);
      for (const cell of cells) {
        assert.ok(cell.x >= 0 && cell.y >= 0, `${shape}/${count} stays inside`);
        assert.ok(cell.x + cell.width <= width && cell.y + cell.height <= height, `${shape}/${count} does not poke out`);
        assert.equal(cell.width % 2, 0, "a cell keeps whole chroma samples");
        assert.equal(cell.height % 2, 0);
      }
      const covered = cells.reduce((sum, cell) => sum + cell.width * cell.height, 0);
      assert.ok(covered / (width * height) > 0.95, `${shape}/${count} fills its frame`);
    }
  }
  assert.equal(mosaicCells(9, "poster").length, 4, "a fifth picture is dropped rather than squeezed in");
  assert.equal(mosaicShape("wide"), "wide");
  assert.equal(mosaicShape("anything else"), "poster");
});

test("three pictures give the first one the left of the frame, four fill a grid", () => {
  const poster = MOSAIC_SIZES.poster;
  const three = mosaicCells(3, "poster");
  assert.ok(three[0]!.width > poster.width / 2, "the hero takes more than half the width");
  assert.equal(three[1]!.x, three[2]!.x, "the two smaller ones share a column");
  assert.ok(three[1]!.y + three[1]!.height <= three[2]!.y, "and are stacked, not overlapping");
  const four = mosaicCells(4, "poster");
  assert.equal(new Set(four.map((cell) => `${cell.x}:${cell.y}`)).size, 4, "every grid cell has its own corner");
});

test("a composed fan is one JPEG at the size a tile draws", { skip: !hasFfmpeg }, async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "stremio-mosaic-source-"));
  try {
    const sources: Buffer[] = [];
    for (const [index, size] of ["400x600", "500x750", "300x450", "640x960"].entries()) {
      const file = path.join(dir, `${index}.jpg`);
      await run(ffmpegPath(), ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", `testsrc=size=${size}:duration=1`, "-frames:v", "1", "-y", file]);
      sources.push(await readFile(file));
    }
    for (const shape of ["poster", "wide"] as const) {
      const composed = await composeMosaic(sources, shape);
      assert.ok(composed.length > 1000, "the fan carries bytes");
      const out = path.join(dir, `${shape}.jpg`);
      await writeFile(out, composed);
      const { stdout } = await run("ffprobe", ["-v", "error", "-select_streams", "v", "-show_entries", "stream=width,height", "-of", "csv=p=0", out]);
      assert.equal(stdout.trim(), `${MOSAIC_SIZES[shape].width},${MOSAIC_SIZES[shape].height}`, `${shape} fan size`);
    }
    await assert.rejects(composeMosaic([], "poster"), /at least one picture/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a fan is kept under its key and the oldest goes when the cap is passed", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "stremio-mosaic-cache-"));
  try {
    const cache = new MosaicCache(dir, 3000, 0);
    const key = "lib_1|dir:films|poster|stamp";
    await cache.write(key, Buffer.alloc(2000, 1));
    assert.equal((await cache.read(key))?.length, 2000, "a written fan comes back");
    await new Promise((done) => setTimeout(done, 20));
    await cache.write("another", Buffer.alloc(2000, 2));
    const files = await readdir(dir);
    assert.equal(files.length, 1, "the older fan is dropped rather than kept past the cap");
    assert.equal((await cache.read(key)), undefined);
    assert.equal((await cache.read("another"))?.length, 2000);
    assert.equal(MosaicCache.stamp(["a", "b"]), MosaicCache.stamp(["a", "b"]));
    assert.notEqual(MosaicCache.stamp(["a", "b"]), MosaicCache.stamp(["b", "a"]), "the order of the pictures is part of the stamp");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
