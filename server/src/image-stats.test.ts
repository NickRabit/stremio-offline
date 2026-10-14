import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { ImageStats, imageSurface, noteImage, useImageStats } from "./image-stats.js";

test("image counts stay inside the selected period and survive a restart", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "image-stats-"));
  const file = path.join(dir, "image-stats.json");
  let now = Date.parse("2026-10-14T12:30:00Z");
  const stats = new ImageStats(file, () => now);
  stats.record("remote", "memory");
  stats.record("remote", "disk");
  stats.record("catalog", "upstream");
  stats.record("library", "disk");
  now = Date.parse("2026-10-14T15:30:00Z");
  stats.record("home", "memory");
  assert.deepEqual(stats.summary(1), {
    catalog: { memory: 0, disk: 0, upstream: 0 },
    library: { memory: 0, disk: 0, upstream: 0 },
    remote: { memory: 0, disk: 0, upstream: 0 },
    home: { memory: 1, disk: 0, upstream: 0 },
  });
  assert.equal(stats.summary(24).library.disk, 1);
  assert.equal(stats.summary(24).remote.memory, 1);
  await stats.flush();
  const restarted = new ImageStats(file, () => now);
  await restarted.load();
  assert.equal(restarted.summary(24).catalog.upstream, 1);
  assert.equal(restarted.summary(24).home.memory, 1);
  const stored = JSON.parse(await readFile(file, "utf8")) as unknown[];
  assert.equal(stored.length, 2);
  await rm(dir, { recursive: true, force: true });
});

test("an unknown surface keeps the store's own layer and an unset counter records nothing", () => {
  assert.equal(imageSurface("home", "remote"), "home");
  assert.equal(imageSurface("nope", "catalog"), "catalog");
  useImageStats(undefined);
  noteImage("library", "memory");
});
