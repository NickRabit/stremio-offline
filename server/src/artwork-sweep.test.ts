import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { ArtworkCache } from "./artwork-cache.js";
import { ART_VARIANTS, artVariantKey } from "./artwork.js";
import { type CheckedWalk, listVideosChecked } from "./library.js";
import { parseLibraryPath } from "./libraries.js";
import { createArtworkSweep, type SweepDeps, type SweepLibrary } from "./artwork-sweep.js";

const exists = async (file: string) => { try { await stat(file); return true; } catch { return false; } };
const OLD = 2 * 60 * 60_000;

interface Harness { cache: ArtworkCache; artworkDir: string; dataDir: string }

const withSweep = async (run: (harness: Harness) => Promise<void>) => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "artwork-sweep-"));
  const artworkDir = path.join(dataDir, "artwork");
  const cache = new ArtworkCache(artworkDir, 1024 * 1024);
  await cache.load();
  try { await run({ cache, artworkDir, dataDir }); }
  finally { await rm(dataDir, { recursive: true, force: true }); }
};

/** The basenames the sweep has to keep, computed the way production does: one file per
 *  `ART_VARIANTS` entry of the key, skipped when the key cannot name a library file. */
const namesFor = (cache: ArtworkCache, key: string) => ART_VARIANTS.flatMap((variant) => {
  const variantKey = artVariantKey(key, variant);
  if (!parseLibraryPath(variantKey.startsWith("dir:") ? variantKey.slice(4) : variantKey)) return [];
  return [path.basename(cache.file(variantKey))];
});

/** Writes a thumbnail and backdates it past the freshness guard unless asked otherwise. */
const put = async (cache: ArtworkCache, key: string, ageMs = OLD) => {
  const file = cache.file(key);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, "thumbnail");
  const when = new Date(Date.now() - ageMs);
  await utimes(file, when, when);
  await cache.written(file);
  return file;
};

const library = (root: string, id = "lib_aaaaaaaa", name = "Films"): SweepLibrary =>
  ({ id, name, root, exclude: new Set<string>() });

const makeSweep = (options: {
  cache: ArtworkCache;
  libraries: SweepLibrary[];
  scan: (library: SweepLibrary) => Promise<CheckedWalk>;
  queuedKeys?: () => string[];
  busy?: () => boolean;
  epoch?: () => number;
  now?: () => number;
  signal?: AbortSignal;
  remove?: (file: string) => Promise<void>;
}) => createArtworkSweep({
  libraries: async () => options.libraries,
  scan: options.scan,
  queuedKeys: options.queuedKeys ?? (() => []),
  artNames: (key) => namesFor(options.cache, key),
  directoryOf: (libraryId) => options.cache.dirOf(libraryId),
  remove: options.remove ?? (async (file) => { await rm(file, { force: true }); await options.cache.removed(file); }),
  busy: options.busy ?? (() => false),
  epoch: options.epoch ?? (() => 0),
  now: options.now ?? (() => Date.now()),
  signal: options.signal ?? new AbortController().signal,
} satisfies SweepDeps);

test("a deleted video's thumbnail goes, live variants, ancestors and a queued key stay", async () => {
  await withSweep(async ({ cache, dataDir }) => {
    const root = path.join(dataDir, "media");
    await mkdir(path.join(root, "Films", "Dune"), { recursive: true });
    await writeFile(path.join(root, "Films", "Dune", "Dune.mkv"), "");
    const lib = library(root);

    const live = await put(cache, "lib_aaaaaaaa/Films/Dune/Dune.mkv");
    const wide = await put(cache, "lib_aaaaaaaa/Films/Dune/Dune.mkv#wide");
    const gallery = await put(cache, "lib_aaaaaaaa/Films/Dune/Dune.mkv#gallery3");
    const folder = await put(cache, "dir:lib_aaaaaaaa/Films/Dune");
    const ancestor = await put(cache, "dir:lib_aaaaaaaa/Films");
    const gone = await put(cache, "lib_aaaaaaaa/Films/Gone/Gone.mkv");
    const fresh = await put(cache, "lib_aaaaaaaa/Films/Fresh/Fresh.mkv", 5 * 60_000);
    const queued = await put(cache, "lib_aaaaaaaa/Films/Queued/Queued.mkv");

    const sweep = makeSweep({
      cache, libraries: [lib],
      scan: (swept) => listVideosChecked(swept.root, swept.exclude),
      queuedKeys: () => ["lib_aaaaaaaa/Films/Queued/Queued.mkv"],
    });
    assert.deepEqual(await sweep(), { removed: 1 });
    for (const file of [live, wide, gallery, folder, ancestor, fresh, queued]) assert.ok(await exists(file), `${file} is kept`);
    assert.equal(await exists(gone), false, "the thumbnail of a video that is gone is removed");
  });
});

test("an empty library is only cleaned when it was empty on the previous pass too", async () => {
  await withSweep(async ({ cache, dataDir }) => {
    const lib = library(path.join(dataDir, "media"));
    const orphan = cache.file("lib_aaaaaaaa/Films/Gone/Gone.mkv");
    await mkdir(path.dirname(orphan), { recursive: true });
    await writeFile(orphan, "thumbnail");
    const mtime = Date.now() - OLD;
    await utimes(orphan, new Date(mtime), new Date(mtime));
    await cache.written(orphan);

    // The clock can keep the orphan fresh while the library briefly turns non-empty, which
    // is what a pass that may not delete it looks like.
    let clock = mtime + 5 * 60_000;
    let files = 0;
    const scan = async (): Promise<CheckedWalk> => ({ files: new Array(files).fill({ relative: "x.mkv", size: 0, modified: "" }), complete: true });
    const sweep = makeSweep({ cache, libraries: [lib], scan, now: () => clock });

    assert.deepEqual(await sweep(), { removed: 0 }, "the first empty pass deletes nothing");
    assert.ok(await exists(orphan), "and keeps the thumbnails");
    files = 1;
    assert.deepEqual(await sweep(), { removed: 0 }, "a non-empty pass keeps the still-fresh orphan and resets the memory");
    assert.ok(await exists(orphan));
    files = 0;
    clock = mtime + OLD + 60_000;
    assert.deepEqual(await sweep(), { removed: 0 }, "so the next empty pass is a first one again");
    assert.deepEqual(await sweep(), { removed: 1 }, "two consecutive empty passes clean up");
    assert.equal(await exists(orphan), false);
  });
});

test("an incomplete, failing or unlisted library is left alone while the others are swept", async () => {
  await withSweep(async ({ cache, dataDir }) => {
    const good = library(path.join(dataDir, "good"), "lib_aaaaaaaa", "Good");
    const partial = library(path.join(dataDir, "partial"), "lib_bbbbbbbb", "Partial");
    const broken = library(path.join(dataDir, "broken"), "lib_cccccccc", "Broken");
    const absent = library(path.join(dataDir, "absent"), "lib_dddddddd", "Absent");

    const goodOrphan = await put(cache, "lib_aaaaaaaa/Films/Gone/Gone.mkv");
    const partialOrphan = await put(cache, "lib_bbbbbbbb/Films/Gone/Gone.mkv");
    const brokenOrphan = await put(cache, "lib_cccccccc/Films/Gone/Gone.mkv");
    const absentOrphan = await put(cache, "lib_dddddddd/Films/Gone/Gone.mkv");

    const scan = async (swept: SweepLibrary): Promise<CheckedWalk> => {
      if (swept.id === partial.id) return { files: [], complete: false };
      if (swept.id === broken.id) throw new Error("the disk went away");
      return { files: [], complete: true };
    };
    const sweep = makeSweep({ cache, libraries: [good, partial, broken], scan });
    // The good library is authoritatively empty twice so its orphan is actually removed.
    await sweep();
    assert.deepEqual(await sweep(), { removed: 1 });
    assert.equal(await exists(goodOrphan), false, "the readable, complete library is swept");
    for (const file of [partialOrphan, brokenOrphan, absentOrphan]) assert.ok(await exists(file), "a library that could not be read keeps its thumbnails");
  });
});

test("a busy cache postpones the whole pass and forgets nothing", async () => {
  await withSweep(async ({ cache, dataDir }) => {
    const lib = library(path.join(dataDir, "media"));
    const orphan = await put(cache, "lib_aaaaaaaa/Films/Gone/Gone.mkv");
    let busy = false;
    const sweep = makeSweep({ cache, libraries: [lib], scan: async () => ({ files: [], complete: true }), busy: () => busy });
    await sweep();
    busy = true;
    assert.deepEqual(await sweep(), { removed: 0 });
    assert.ok(await exists(orphan), "nothing is removed while a library operation runs");
    busy = false;
    assert.deepEqual(await sweep(), { removed: 0 }, "the empty memory was dropped, so this counts as a first pass");
    assert.deepEqual(await sweep(), { removed: 1 });
  });
});

test("an epoch that changes during the pass stops the removals and the next pass finishes them", async () => {
  await withSweep(async ({ cache, dataDir }) => {
    const lib = library(path.join(dataDir, "media"));
    const first = await put(cache, "lib_aaaaaaaa/Films/One/One.mkv");
    const second = await put(cache, "lib_aaaaaaaa/Films/Two/Two.mkv");
    let epoch = 0;
    const scan = async (): Promise<CheckedWalk> => {
      epoch += 1;   // the scan itself is a mutation: the valid set may be stale at once
      return { files: [], complete: true };
    };
    const sweep = makeSweep({ cache, libraries: [lib], scan, epoch: () => epoch });
    // First pass only records the empty suspicion; both passes below still see the bump.
    await sweep();
    assert.deepEqual(await sweep(), { removed: 0 }, "a change between the scan and the first removal stops it");
    assert.ok(await exists(first) && await exists(second));
  });

  await withSweep(async ({ cache, dataDir }) => {
    const lib = library(path.join(dataDir, "media"));
    const one = await put(cache, "lib_aaaaaaaa/Films/One/One.mkv");
    const two = await put(cache, "lib_aaaaaaaa/Films/Two/Two.mkv");
    let epoch = 0;
    let removals = 0;
    const sweep = makeSweep({
      cache, libraries: [lib], epoch: () => epoch,
      scan: async () => ({ files: [], complete: true }),
      remove: async (file) => { removals += 1; epoch += 1; await rm(file, { force: true }); await cache.removed(file); },
    });
    await sweep();  // first empty pass
    const result = await sweep();
    assert.equal(result.removed, 1, "the first removal happens before the epoch moves");
    assert.equal(removals, 1);
    // Whichever file was removed, the other was left for the next pass.
    assert.equal([await exists(one), await exists(two)].filter(Boolean).length, 1, "the change stops the rest");
    epoch += 10;
    assert.deepEqual(await sweep(), { removed: 0 }, "an interrupted pass is not counted as the previous empty one");
    assert.deepEqual(await sweep(), { removed: 1 }, "and the next pass completes the job");
  });
});

test("a failing removal does not stop the others or the count, and an aborted signal stops the pass", async () => {
  await withSweep(async ({ cache, dataDir }) => {
    const lib = library(path.join(dataDir, "media"));
    const one = await put(cache, "lib_aaaaaaaa/Films/One/One.mkv");
    const two = await put(cache, "lib_aaaaaaaa/Films/Two/Two.mkv");
    const three = await put(cache, "lib_aaaaaaaa/Films/Three/Three.mkv");
    const sweep = makeSweep({
      cache, libraries: [lib], scan: async () => ({ files: [], complete: true }),
      remove: async (file) => {
        if (file === one) throw new Error("busy");
        await rm(file, { force: true });
        await cache.removed(file);
      },
    });
    await sweep();
    assert.deepEqual(await sweep(), { removed: 2 }, "the failed file is not counted, the others still go");
    assert.ok(await exists(one), "the one that failed stays");
    assert.equal(await exists(two), false);
    assert.equal(await exists(three), false);
  });

  await withSweep(async ({ cache, dataDir }) => {
    const controller = new AbortController();
    const lib = library(path.join(dataDir, "media"));
    const one = await put(cache, "lib_aaaaaaaa/Films/One/One.mkv");
    const two = await put(cache, "lib_aaaaaaaa/Films/Two/Two.mkv");
    const sweep = makeSweep({
      cache, libraries: [lib], signal: controller.signal,
      scan: async () => ({ files: [], complete: true }),
      remove: async (file) => { await rm(file, { force: true }); await cache.removed(file); controller.abort(); },
    });
    await sweep();
    assert.deepEqual(await sweep(), { removed: 1 }, "the abort is noticed between files");
    assert.equal([await exists(one), await exists(two)].filter(Boolean).length, 1, "and the rest of the pass stops");
  });

  await withSweep(async ({ cache, dataDir }) => {
    const controller = new AbortController();
    const lib = library(path.join(dataDir, "media"));
    const orphan = await put(cache, "lib_aaaaaaaa/Films/Gone/Gone.mkv");
    controller.abort();
    const sweep = makeSweep({ cache, libraries: [lib], scan: async () => ({ files: [], complete: true }), signal: controller.signal });
    assert.deepEqual(await sweep(), { removed: 0 });
    assert.ok(await exists(orphan), "an aborted pass removes nothing");
  });
});

test("the directory of a library that is not configured is never read", async () => {
  await withSweep(async ({ cache, dataDir }) => {
    const lib = library(path.join(dataDir, "media"));
    const departed = await put(cache, "lib_deadbeef/Films/Gone/Gone.mkv");
    const sweep = makeSweep({ cache, libraries: [lib], scan: async () => ({ files: [], complete: true }) });
    await sweep();
    await sweep();
    assert.ok(await exists(departed), "a departed but not forgotten library keeps its directory");
  });
});
