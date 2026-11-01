import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { episodesInTarget } from "./bulk-target.js";

test("structured targets report video episodes in the series folder", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "bulk-target-structured-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, "Shows", "Show", "01 serie"), { recursive: true });
  await mkdir(path.join(root, "Shows", "Show", "02 serie"), { recursive: true });
  await mkdir(path.join(root, "Shows", "Other", "01 serie"), { recursive: true });
  await writeFile(path.join(root, "Shows", "Show", "01 serie", "Show - S01E01.mkv"), "");
  await writeFile(path.join(root, "Shows", "Show", "02 serie", "02.mp4"), "");
  await writeFile(path.join(root, "Shows", "Show", "02 serie", "notes.txt"), "");
  await writeFile(path.join(root, "Shows", "Other", "01 serie", "Other - S01E01.mkv"), "");

  assert.deepEqual(
    await episodesInTarget({
      root,
      settings: { subfolder: "Shows", layout: "structured" },
      seriesTitle: "Show",
    }),
    new Set(["1:1", "2:2"]),
  );
});

test("flat targets report only videos named for the requested series", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "bulk-target-flat-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, "Shows"), { recursive: true });
  await writeFile(path.join(root, "Shows", "Show - S01E03.mkv"), "");
  await writeFile(path.join(root, "Shows", "Show - S01E04.srt"), "");
  await writeFile(path.join(root, "Shows", "Other - S01E04.mkv"), "");

  assert.deepEqual(
    await episodesInTarget({
      root,
      settings: { subfolder: "Shows", layout: "flat" },
      seriesTitle: "Show",
    }),
    new Set(["1:3"]),
  );
});

test("a missing target folder is empty", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "bulk-target-missing-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  assert.deepEqual(
    await episodesInTarget({
      root,
      settings: { subfolder: "Absent", layout: "structured" },
      seriesTitle: "Show",
    }),
    new Set(),
  );
});
