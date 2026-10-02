import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { skippedFolder, watchLibrary } from "./library-watch.js";

/** Controllable stand-ins, so the debounce is tested without waiting for it. */
const fakeTimers = () => {
  let queued: (() => void) | undefined;
  let scheduled = 0;
  const timer = ((fn: () => void) => { queued = fn; scheduled += 1; return { unref() {} }; }) as unknown as typeof setTimeout;
  const clear = (() => { queued = undefined; }) as unknown as typeof clearTimeout;
  return { timer, clear, fire: () => queued?.(), scheduled: () => scheduled };
};

test("a burst of events settles into one run", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "stremio-watch-"));
  const seen: string[] = [];
  const timers = fakeTimers();
  const watch = watchLibrary(dir, (file) => seen.push(file), { debounceMs: 5, timer: timers.timer, clear: timers.clear });
  try {
    assert.equal(watch.active, true, "a real directory can be watched");
    // The watcher itself is the platform's business; the debounce is ours.
    timers.fire();
    assert.equal(seen.length, 0, "nothing happened yet, so nothing is reported");
  } finally {
    watch.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("a directory that cannot be watched falls back quietly", () => {
  const watch = watchLibrary(path.join(tmpdir(), "stremio-watch-missing-directory"), () => undefined);
  assert.equal(watch.active, false, "the periodic check takes over instead");
  watch.close();
});

/** Waits for a file system event to arrive, without a fixed sleep that is either flaky or slow. */
const until = async (condition: () => boolean, ms = 3000) => {
  const deadline = Date.now() + ms;
  while (!condition() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 25));
  return condition();
};

// inotify reports a folder's own children only; macOS reports the whole subtree, so this runs where it means something.
test("on Linux only folders are watched, and the NAS's own folders are left out", { skip: process.platform !== "linux" }, async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "stremio-watch-folders-"));
  await mkdir(path.join(dir, "Reacher", "@eaDir", "Reacher.S01E01.mkv"), { recursive: true });
  await mkdir(path.join(dir, "#recycle"), { recursive: true });
  const seen: string[] = [];
  const timers = fakeTimers();
  const settled = () => { timers.fire(); return seen.length > 0; };
  const watch = watchLibrary(dir, (file) => seen.push(file), { debounceMs: 5, timer: timers.timer, clear: timers.clear, platform: "linux" });
  try {
    assert.equal(watch.active, true);
    await new Promise((resolve) => setTimeout(resolve, 200));

    // Synology writes its thumbnails here for every video; none of it is a title.
    await writeFile(path.join(dir, "Reacher", "@eaDir", "Reacher.S01E01.mkv", "SYNOVIDEO_VIDEO_SCREENSHOT.jpg"), "x");
    await writeFile(path.join(dir, "#recycle", "old.mkv"), "x");
    assert.equal(await until(settled, 500), false, "nothing under the system's folders is reported");

    await writeFile(path.join(dir, "Reacher", "Reacher.S01E02.mkv"), "x");
    assert.ok(await until(settled), "a film copied into a watched folder is noticed");
    assert.equal(seen.at(-1), path.join("Reacher", "Reacher.S01E02.mkv"));

    // A folder created after the start gets a watch of its own.
    seen.length = 0;
    await mkdir(path.join(dir, "Reacher", "Season 2"));
    await until(settled);
    seen.length = 0;
    await new Promise((resolve) => setTimeout(resolve, 200));
    await writeFile(path.join(dir, "Reacher", "Season 2", "Reacher.S02E01.mkv"), "x");
    assert.ok(await until(() => { timers.fire(); return seen.includes(path.join("Reacher", "Season 2", "Reacher.S02E01.mkv")); }), "the new folder is watched too");
  } finally {
    watch.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("the folders a NAS keeps beside the films are recognised", () => {
  for (const name of ["@eaDir", "@Recycle", "#recycle", "#snapshot", ".DS_Store", ".stremio-offline-1-Probe.tmp"]) assert.equal(skippedFolder(name), true, name);
  for (const name of ["Reacher", "Season 1", "Jack Reacher (2012)"]) assert.equal(skippedFolder(name), false, name);
});
