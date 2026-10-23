import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { createLibraryActions, type LibraryActionDeps, type TransferStep } from "./library-actions.js";
import type { FoundFile } from "./library.js";
import type { LibraryRecord } from "./libraries.js";

/** The operations are exercised through the factory with fakes: no server boot, and the only
 *  thing that touches a disk is the placeholder probe, which is a real file system call. */

const LIBRARY_ID = "lib_ab12cd34";
const library: LibraryRecord = {
  id: LIBRARY_ID, name: "Films", type: "mixed", root: "/library", enabled: true, order: 0, addedAt: "", writeArtwork: true,
};

const exists = async (file: string) => { try { await access(file); return true; } catch { return false; } };

const harness = (options: { holds?: (key: string) => boolean; libraries?: () => LibraryRecord[]; files?: Array<{ relative: string }> } = {}) => {
  const calls = {
    relocate: [] as Array<{ from: string; to: string; pin: boolean }>,
    moved: [] as string[],
    invalidated: 0,
    cleared: [] as string[],
  };
  const holds = options.holds ?? (() => false);
  const deps: LibraryActionDeps = {
    store: { libraries: options.libraries ?? (() => [library]) },
    metaStore: {
      qualifiedMeta: () => ({}),
      update: async () => undefined,
      relocate: async (from: string, to: string, pin = false) => { calls.relocate.push({ from, to, pin }); },
      copy: async () => undefined,
      holds,
      flush: async () => undefined,
    },
    artworks: {
      moveKey: async (from: string) => { calls.moved.push(from); return { carried: true as const }; },
      copyKey: async () => ({ carried: true as const }),
    },
    libraryFiles: async () => (options.files ?? []) as FoundFile[],
    libraryUnits: async () => [],
    carveOutsOf: () => new Set<string>(),
    healthOf: (entry) => ({ unreachable: false, readOnly: false, realRoot: entry.root, caseInsensitive: false }),
    libraryOfKey: () => ({ library, relative: "" }),
    wirePath: (key) => key,
    mediaPath: (key) => `/library/${key}`,
    fileExists: exists,
    isFileKey: (key) => key.endsWith(".mkv"),
    removeGeneratedArt: async (key) => { calls.cleared.push(key); },
    ownRecord: () => undefined,
    progressOf: () => ({}),
    watchlistOf: () => ({}),
    updateEveryData: async () => undefined,
    invalidateLibrary: () => { calls.invalidated += 1; },
    setLibraryOpsWriting: () => undefined,
  };
  return { actions: createLibraryActions(deps), calls };
};

test("resumeTransfer finishes a published record from what it says", async () => {
  const step: TransferStep = {
    phase: "published", copy: false,
    from: `${LIBRARY_ID}/Old/movie.mkv`, to: `${LIBRARY_ID}/New/movie.mkv`, carried: [],
  };
  const { actions, calls } = harness();
  assert.equal(await actions.resumeTransfer(step), step.to);
  // A replay only relocates when the source still holds rows or the destination does not.
  assert.deepEqual(calls.relocate, [{ from: step.from, to: step.to, pin: true }]);
  assert.equal(calls.invalidated, 1);
});

test("a changed binding clears the item's pictures, its files' and the folders between them", async () => {
  const { actions, calls } = harness({
    files: [
      { relative: `${LIBRARY_ID}/Show/01 serie/S01E01.mkv` },
      { relative: `${LIBRARY_ID}/Show/01 serie/S01E02.mkv` },
      { relative: `${LIBRARY_ID}/Show/extra.mkv` },
      { relative: `${LIBRARY_ID}/Show 2/01.mkv` },
    ],
  });
  await actions.clearGeneratedArt(`${LIBRARY_ID}/Show`);
  assert.deepEqual(calls.cleared, [
    `${LIBRARY_ID}/Show`,
    `${LIBRARY_ID}/Show/01 serie/S01E01.mkv`,
    `${LIBRARY_ID}/Show/01 serie`,
    `${LIBRARY_ID}/Show/01 serie/S01E02.mkv`,
    `${LIBRARY_ID}/Show/extra.mkv`,
  ], "a season folder's own picture goes stale with its episodes, and a similar name is another item");
});

test("resumeTransfer drops a reserved placeholder and runs the transfer from the start", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "library-actions-"));
  try {
    await mkdir(path.join(root, "Old"));
    await mkdir(path.join(root, "New"));
    await writeFile(path.join(root, "Old/movie.mkv"), "video");
    await writeFile(path.join(root, "New/movie.mkv"), "");
    const { actions } = harness({ libraries: () => [{ ...library, root }] });
    const step: TransferStep = {
      phase: "moving", copy: false,
      from: `${LIBRARY_ID}/Old/movie.mkv`, to: `${LIBRARY_ID}/New/movie.mkv`, carried: [],
    };
    assert.equal(await actions.resumeTransfer(step), undefined);
    assert.equal(await exists(path.join(root, "New/movie.mkv")), false, "the placeholder is gone");
    assert.equal(await exists(path.join(root, "Old/movie.mkv")), true, "the source is still there");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("resumeTransfer refuses when neither end holds the item", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "library-actions-"));
  try {
    const { actions } = harness({ libraries: () => [{ ...library, root }] });
    const step: TransferStep = {
      phase: "moving", copy: false,
      from: `${LIBRARY_ID}/Old/movie.mkv`, to: `${LIBRARY_ID}/New/movie.mkv`, carried: [],
    };
    await assert.rejects(actions.resumeTransfer(step), /The file or folder does not exist\./);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a replayed finishTransfer leaves the destination's carried rows unpinned", async () => {
  const step: TransferStep = {
    phase: "moving", copy: false,
    from: `${LIBRARY_ID}/Old/movie.mkv`, to: `${LIBRARY_ID}/New/movie.mkv`, carried: [],
  };
  const replayed = harness({ holds: (key) => key === step.to });
  assert.equal(await replayed.actions.finishTransfer(step, undefined, true), step.to);
  assert.deepEqual(replayed.calls.relocate, [], "the rows already at the destination are not pinned over");
  const fresh = harness();
  assert.equal(await fresh.actions.finishTransfer(step), step.to);
  assert.deepEqual(fresh.calls.relocate, [{ from: step.from, to: step.to, pin: true }]);
});

const withRoot = async (files: string[], run: (root: string, actions: ReturnType<typeof createLibraryActions>) => Promise<void>) => {
  const root = await mkdtemp(path.join(tmpdir(), "library-actions-"));
  try {
    for (const file of files) {
      await mkdir(path.dirname(path.join(root, file)), { recursive: true });
      await writeFile(path.join(root, file), file);
    }
    const { actions } = harness({ libraries: () => [{ ...library, root }] });
    await run(root, actions);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
};

test("deleting a video deletes its subtitles, not another title's", async () => {
  await withRoot(["Films/Heat.mkv", "Films/Heat.srt", "Films/Heat.cs.vtt", "Films/Heat 2.srt"], async (root, actions) => {
    await actions.deleteLibraryItem(`${LIBRARY_ID}/Films/Heat.mkv`);
    assert.equal(await exists(path.join(root, "Films/Heat.mkv")), false);
    assert.equal(await exists(path.join(root, "Films/Heat.srt")), false);
    assert.equal(await exists(path.join(root, "Films/Heat.cs.vtt")), false);
    assert.equal(await exists(path.join(root, "Films/Heat 2.srt")), true);
  });
});

test("a subtitle another video of the same name still uses stays behind", async () => {
  await withRoot(["Films/Heat.mkv", "Films/Heat.mp4", "Films/Heat.srt"], async (root, actions) => {
    await actions.deleteLibraryItem(`${LIBRARY_ID}/Films/Heat.mkv`);
    assert.equal(await exists(path.join(root, "Films/Heat.srt")), true);
  });
});

test("moving a video takes its subtitles along", async () => {
  await withRoot(["Films/Heat.mkv", "Films/Heat.en.srt", "Archive/.keep"], async (root, actions) => {
    await actions.transferLibraryItem(`${LIBRARY_ID}/Films/Heat.mkv`, `${LIBRARY_ID}/Archive`);
    assert.equal(await exists(path.join(root, "Archive/Heat.mkv")), true);
    assert.equal(await exists(path.join(root, "Archive/Heat.en.srt")), true);
    assert.equal(await exists(path.join(root, "Films/Heat.en.srt")), false);
  });
});

test("copying a video copies its subtitles and leaves the originals", async () => {
  await withRoot(["Films/Heat.mkv", "Films/Heat.srt", "Archive/.keep"], async (root, actions) => {
    await actions.transferLibraryItem(`${LIBRARY_ID}/Films/Heat.mkv`, `${LIBRARY_ID}/Archive`, true);
    assert.equal(await exists(path.join(root, "Archive/Heat.srt")), true);
    assert.equal(await exists(path.join(root, "Films/Heat.srt")), true);
  });
});

test("a subtitle already at the destination is never overwritten", async () => {
  await withRoot(["Films/Heat.mkv", "Films/Heat.srt", "Archive/Heat.srt"], async (root, actions) => {
    await actions.transferLibraryItem(`${LIBRARY_ID}/Films/Heat.mkv`, `${LIBRARY_ID}/Archive`);
    const { readFile } = await import("node:fs/promises");
    assert.equal(await readFile(path.join(root, "Archive/Heat.srt"), "utf8"), "Archive/Heat.srt", "the one there stays");
    assert.equal(await exists(path.join(root, "Films/Heat.srt")), true, "the source's subtitle is kept rather than lost");
  });
});
