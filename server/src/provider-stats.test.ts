import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ProviderStats, noteProviderCall, useProviderStats } from "./provider-stats.js";

const withDir = async (run: (dir: string) => Promise<void>) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "stremio-provider-stats-"));
  try { await run(dir); } finally { await rm(dir, { recursive: true, force: true }); }
};

test("counts land in one hourly bucket per kind and survive a reload", async () => {
  await withDir(async (dir) => {
    const file = path.join(dir, "provider-stats.json");
    let now = Date.UTC(2026, 0, 2, 3, 10);
    const stats = new ProviderStats(file, () => now);
    await stats.load();
    stats.record("detail");
    stats.record("detail");
    stats.record("ancestors");
    now += 90 * 60_000;
    stats.record("artwork");
    await stats.flush();

    const summary = stats.summary(6, now);
    assert.equal(summary.detail, 2);
    assert.equal(summary.ancestors, 1);
    assert.equal(summary.artwork, 1, "the later call is inside the window");
    assert.equal(summary.versions, 0, "a kind nobody asked for stays zero");
    assert.equal(stats.summary(1, now).detail, 0, "the older hour falls outside a one-hour window");

    const reloaded = new ProviderStats(file, () => now);
    await reloaded.load();
    assert.equal(reloaded.summary(6, now).detail, 2);
    assert.equal(reloaded.summary(6, now).artwork, 1);
  });
});

test("a damaged file starts the counts empty rather than failing", async () => {
  await withDir(async (dir) => {
    const file = path.join(dir, "provider-stats.json");
    await writeFile(file, JSON.stringify([{ at: "not a date" }, { at: new Date().toISOString(), detail: "many" }, null]));
    const stats = new ProviderStats(file);
    await stats.load();
    assert.equal(stats.summary(6).detail, 0, "a count that is not a number is dropped");
  });
});

test("the hop records nothing until a store is installed", async () => {
  useProviderStats(undefined);
  noteProviderCall("detail");
  await withDir(async (dir) => {
    const stats = new ProviderStats(path.join(dir, "provider-stats.json"));
    useProviderStats(stats);
    try {
      noteProviderCall("versions");
      assert.equal(stats.summary(1).versions, 1);
    } finally {
      useProviderStats(undefined);
    }
  });
  noteProviderCall("versions");
});
