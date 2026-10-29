import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { ImageStats, askedSurface, imageSurface, logPoster, noteImage, useImageStats, type StatsSaveTimers } from "./image-stats.js";
import { flushLog, initLogger, setLevel } from "./logger.js";

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
  assert.equal(askedSurface(undefined), "unset");
  assert.equal(askedSurface("home"), "home");
  assert.equal(askedSurface("nope"), "other");
  useImageStats(undefined);
  noteImage("library", "memory");
});

test("routine poster successes are debug diagnostics rather than info log appends", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "image-stats-log-"));
  const previousMirror = process.env.LOG_STDOUT;
  process.env.LOG_STDOUT = "0";
  try {
    await initLogger(dir);
    setLevel("INFO");
    logPoster({ kind: "catalog", surface: "catalog", asked: "catalog", from: "memory", status: 200, bytes: 64 });
    await flushLog();
    assert.equal(await readFile(path.join(dir, "app.log"), "utf8").catch(() => ""), "");

    setLevel("DEBUG");
    logPoster({ kind: "catalog", surface: "catalog", asked: "catalog", from: "memory", status: 200, bytes: 64 });
    await flushLog();
    const detail = await readFile(path.join(dir, "app.log"), "utf8");
    assert.match(detail, /DEBUG Poster served/);
    assert.match(detail, /"from":"memory"/);
  } finally {
    setLevel("INFO");
    if (previousMirror === undefined) delete process.env.LOG_STDOUT;
    else process.env.LOG_STDOUT = previousMirror;
    await rm(dir, { recursive: true, force: true });
  }
});

test("a failed write neither stops the later ones nor loses the counts it carried", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "image-stats-"));
  const file = path.join(dir, "image-stats.json");
  const now = Date.parse("2026-10-14T12:30:00Z");
  const stats = new ImageStats(file, () => now);
  // A directory where the temporary file goes makes the write fail, the way a full disk would.
  await mkdir(`${file}.tmp`);
  stats.record("remote", "disk");
  await assert.rejects(stats.flush());
  await rm(`${file}.tmp`, { recursive: true });
  await stats.flush();
  const restarted = new ImageStats(file, () => now);
  await restarted.load();
  assert.equal(restarted.summary(24).remote.disk, 1, "the count of the failed write lands with the next one");
  await rm(dir, { recursive: true, force: true });
});

test("a flush that waits on a write already in flight writes again when that one fails", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "image-stats-"));
  const file = path.join(dir, "image-stats.json");
  const now = Date.parse("2026-10-14T12:30:00Z");
  const stats = new ImageStats(file, () => now);
  await mkdir(`${file}.tmp`);
  stats.record("remote", "disk");
  // The debounced write is under way when shutdown asks for its own flush; the first one fails.
  const inFlight = stats.flush();
  inFlight.catch(() => rmSync(`${file}.tmp`, { recursive: true }));
  const shutdown = stats.flush();
  await assert.rejects(inFlight);
  await shutdown;
  const restarted = new ImageStats(file, () => now);
  await restarted.load();
  assert.equal(restarted.summary(24).remote.disk, 1, "the shutdown flush writes what the failed write carried");
  await rm(dir, { recursive: true, force: true });
});

test("a continuous stream of image events schedules one bounded periodic write", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "image-stats-batch-"));
  const file = path.join(dir, "image-stats.json");
  const scheduled: Array<{ run: () => void; ms: number }> = [];
  const timers: StatsSaveTimers = {
    set: (run, ms) => { const timer = { run, ms }; scheduled.push(timer); return timer; },
    clear: (handle) => { const at = scheduled.indexOf(handle as { run: () => void; ms: number }); if (at >= 0) scheduled.splice(at, 1); },
  };
  const now = Date.parse("2026-10-14T12:30:00Z");
  const stats = new ImageStats(file, () => now, timers);
  try {
    stats.record("remote", "memory");
    stats.record("remote", "disk");
    stats.record("library", "upstream");
    assert.equal(scheduled.length, 1, "the first event arms one timer");
    assert.equal(scheduled[0]!.ms, 45_000);

    scheduled.shift()!.run();
    let persisted = false;
    for (let attempt = 0; attempt < 100 && !persisted; attempt += 1) {
      persisted = await readFile(file, "utf8").then(() => true, () => false);
      if (!persisted) await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.equal(persisted, true, "the periodic write lands");
    assert.equal(stats.summary(1).remote.memory, 1, "the in-memory summary never waits for disk");
    assert.equal(stats.summary(1).remote.disk, 1);
    const restarted = new ImageStats(file, () => now);
    await restarted.load();
    assert.equal(restarted.summary(1).remote.disk, 1);
    assert.equal(restarted.summary(1).library.upstream, 1);
    assert.equal(scheduled.length, 0, "idle time arms no further write");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a failed image write arms another periodic retry", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "image-stats-retry-"));
  const file = path.join(dir, "image-stats.json");
  const scheduled: Array<{ run: () => void; ms: number }> = [];
  const timers: StatsSaveTimers = {
    set: (run, ms) => { const timer = { run, ms }; scheduled.push(timer); return timer; },
    clear: (handle) => { const at = scheduled.indexOf(handle as { run: () => void; ms: number }); if (at >= 0) scheduled.splice(at, 1); },
  };
  const now = Date.parse("2026-10-14T12:30:00Z");
  const stats = new ImageStats(file, () => now, timers);
  try {
    await mkdir(`${file}.tmp`);
    stats.record("remote", "disk");
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
    const restarted = new ImageStats(file, () => now);
    await restarted.load();
    assert.equal(restarted.summary(1).remote.disk, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
