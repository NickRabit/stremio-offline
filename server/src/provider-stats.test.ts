import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ProviderStats, noteProviderCall, useProviderStats } from "./provider-stats.js";
import type { StatsSaveTimers } from "./image-stats.js";

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

test("a bucket written before playback reports existed loads the missing count as zero", async () => {
  await withDir(async (dir) => {
    const file = path.join(dir, "provider-stats.json");
    await writeFile(file, JSON.stringify([{ at: new Date().toISOString(), detail: 4, original: 2 }]));
    const stats = new ProviderStats(file);
    await stats.load();
    const summary = stats.summary(1);
    assert.equal(summary.detail, 4);
    assert.equal(summary.original, 2);
    assert.equal(summary.playback, 0);
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

test("a failed write neither stops the later ones nor loses the counts it carried", async () => {
  await withDir(async (dir) => {
    const file = path.join(dir, "provider-stats.json");
    const now = Date.UTC(2026, 0, 2, 3, 10);
    const stats = new ProviderStats(file, () => now);
    await stats.load();
    // A directory where the temporary file goes makes the write fail, the way a full disk would.
    await mkdir(`${file}.tmp`);
    stats.record("detail");
    await assert.rejects(stats.flush());
    await rm(`${file}.tmp`, { recursive: true });
    await stats.flush();
    const reloaded = new ProviderStats(file, () => now);
    await reloaded.load();
    assert.equal(reloaded.summary(6, now).detail, 1, "the count of the failed write lands with the next one");
  });
});

test("a flush that waits on a write already in flight writes again when that one fails", async () => {
  await withDir(async (dir) => {
    const file = path.join(dir, "provider-stats.json");
    const now = Date.UTC(2026, 0, 2, 3, 10);
    const stats = new ProviderStats(file, () => now);
    await stats.load();
    await mkdir(`${file}.tmp`);
    stats.record("detail");
    // The debounced write is under way when shutdown asks for its own flush; the first one fails.
    const inFlight = stats.flush();
    inFlight.catch(() => rmSync(`${file}.tmp`, { recursive: true }));
    const shutdown = stats.flush();
    await assert.rejects(inFlight);
    await shutdown;
    const reloaded = new ProviderStats(file, () => now);
    await reloaded.load();
    assert.equal(reloaded.summary(6, now).detail, 1, "the shutdown flush writes what the failed write carried");
  });
});

test("a continuous stream of provider events schedules one bounded periodic write", async () => {
  await withDir(async (dir) => {
    const file = path.join(dir, "provider-stats.json");
    const scheduled: Array<{ run: () => void; ms: number }> = [];
    const timers: StatsSaveTimers = {
      set: (run, ms) => { const timer = { run, ms }; scheduled.push(timer); return timer; },
      clear: (handle) => { const at = scheduled.indexOf(handle as { run: () => void; ms: number }); if (at >= 0) scheduled.splice(at, 1); },
    };
    const now = Date.UTC(2026, 0, 2, 3, 10);
    const stats = new ProviderStats(file, () => now, timers);
    await stats.load();
    stats.record("detail");
    stats.record("artwork");
    stats.record("items");
    assert.equal(scheduled.length, 1);
    assert.equal(scheduled[0]!.ms, 45_000);

    scheduled.shift()!.run();
    let persisted = false;
    for (let attempt = 0; attempt < 100 && !persisted; attempt += 1) {
      persisted = await readFile(file, "utf8").then(() => true, () => false);
      if (!persisted) await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.equal(persisted, true, "the periodic write lands");
    const reloaded = new ProviderStats(file, () => now);
    await reloaded.load();
    assert.equal(reloaded.summary(1).detail, 1);
    assert.equal(reloaded.summary(1).artwork, 1);
    assert.equal(reloaded.summary(1).items, 1);
    assert.equal(scheduled.length, 0, "idle time arms no further write");
  });
});

test("a failed provider write arms another periodic retry", async () => {
  await withDir(async (dir) => {
    const file = path.join(dir, "provider-stats.json");
    const scheduled: Array<{ run: () => void; ms: number }> = [];
    const timers: StatsSaveTimers = {
      set: (run, ms) => { const timer = { run, ms }; scheduled.push(timer); return timer; },
      clear: (handle) => { const at = scheduled.indexOf(handle as { run: () => void; ms: number }); if (at >= 0) scheduled.splice(at, 1); },
    };
    const now = Date.UTC(2026, 0, 2, 3, 10);
    const stats = new ProviderStats(file, () => now, timers);
    await mkdir(`${file}.tmp`);
    stats.record("detail");
    await assert.rejects(stats.flush());
    assert.deepEqual(scheduled.map((timer) => timer.ms), [45_000], "the failed write owes another retry");
    await rm(`${file}.tmp`, { recursive: true });
    scheduled.shift()!.run();
    let persisted = false;
    for (let attempt = 0; attempt < 100 && !persisted; attempt += 1) {
      persisted = await readFile(file, "utf8").then(() => true, () => false);
      if (!persisted) await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.equal(persisted, true);
    const reloaded = new ProviderStats(file, () => now);
    await reloaded.load();
    assert.equal(reloaded.summary(1).detail, 1);
  });
});
