import assert from "node:assert/strict";
import { access, chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { captureTransferIdentity } from "./library-recovery.js";
import { createLibraryActions, type LibraryActionDeps, type TransferStep } from "./library-actions.js";
import { ART_VARIANTS, artVariantKey } from "./artwork.js";
import { carryMovePairs, type FingerprintPair } from "./library-fingerprints.js";
import type { FoundFile } from "./library.js";
import { LibraryMetaStore } from "./library-meta-store.js";
import { titleUnits, type LibraryMetaRecord, type TitleUnit } from "./library-match.js";
import { buildSplitPlan } from "./library-split.js";
import { LibrarySeenStore } from "./library-seen.js";
import { parseLibraryPath, type LibraryRecord } from "./libraries.js";
import type { UserData } from "./users.js";

/** The operations are exercised through the factory with fakes: no server boot, and the only
 *  thing that touches a disk is the placeholder probe, which is a real file system call. */

const LIBRARY_ID = "lib_ab12cd34";
const library: LibraryRecord = {
  id: LIBRARY_ID, name: "Films", type: "mixed", root: "/library", enabled: true, order: 0, addedAt: "", writeArtwork: true,
};

const exists = async (file: string) => { try { await access(file); return true; } catch { return false; } };

const harness = (options: {
  holds?: (key: string) => boolean;
  libraries?: () => LibraryRecord[];
  files?: Array<{ relative: string }>;
  metaStore?: LibraryActionDeps["metaStore"];
  artworks?: LibraryActionDeps["artworks"];
  seen?: LibraryActionDeps["seen"];
  updateEveryData?: LibraryActionDeps["updateEveryData"];
  progressOf?: LibraryActionDeps["progressOf"];
  carveOuts?: ReadonlySet<string>;
  units?: TitleUnit[] | (() => TitleUnit[]);
} = {}) => {
  const calls = {
    relocate: [] as Array<{ from: string; to: string; pin: boolean; unit?: string }>,
    moved: [] as string[],
    invalidated: 0,
    cleared: [] as string[],
    seenMoves: [] as Array<{ libraryId: string; from: string; toLibraryId: string; to: string }>,
    libraryFilesReads: 0,
  };
  const holds = options.holds ?? (() => false);
  const libraries = options.libraries ?? (() => [library]);
  const libraryOfKey = (key: string) => {
    const parsed = parseLibraryPath(key);
    const found = parsed ? libraries().find((entry) => entry.id === parsed.libraryId) : libraries()[0];
    if (!found) throw new Error(`No library for ${key}`);
    return { library: found, relative: parsed?.relative ?? key };
  };
  const deps: LibraryActionDeps = {
    store: { libraries },
    metaStore: options.metaStore ?? {
      qualifiedMeta: () => ({}),
      update: async () => undefined,
      relocate: async (from: string, to: string, pin = false, _policy?: string, unit?: string) => { calls.relocate.push({ from, to, pin, ...(unit ? { unit } : {}) }); },
      copy: async () => undefined,
      holds,
      flushLibrary: async () => undefined,
    },
    artworks: options.artworks ?? {
      moveKey: async (from: string) => { calls.moved.push(from); return { carried: true as const }; },
      copyKey: async () => ({ carried: true as const }),
    },
    libraryFiles: async () => {
      calls.libraryFilesReads += 1;
      return (options.files ?? []) as FoundFile[];
    },
    libraryUnits: async () => (typeof options.units === "function" ? options.units() : options.units) ?? [],
    carveOutsOf: () => options.carveOuts ?? new Set<string>(),
    healthOf: (entry) => ({ unreachable: false, readOnly: false, realRoot: entry.root, caseInsensitive: false }),
    libraryOfKey,
    wirePath: (key) => key,
    fileExists: exists,
    isFileKey: (key) => key.endsWith(".mkv"),
    removeGeneratedArt: async (key) => { calls.cleared.push(key); },
    ownRecord: () => undefined,
    progressOf: options.progressOf ?? (() => ({})),
    watchlistOf: () => ({}),
    updateEveryData: options.updateEveryData ?? (async () => undefined),
    invalidateLibrary: () => { calls.invalidated += 1; },
    seen: options.seen ?? {
      move: (libraryId: string, from: string, toLibraryId: string, to: string) => {
        calls.seenMoves.push({ libraryId, from, toLibraryId, to });
      },
    },
    setLibraryOpsWriting: () => undefined,
  };
  return { actions: createLibraryActions(deps), calls };
};

const recordingJournal = (recorded?: unknown) => {
  const written: unknown[] = [];
  return {
    written,
    journal: {
      recorded,
      record: async (data: unknown) => { written.push(data); },
    },
  };
};

const identityAt = (root: string, relative: string) => captureTransferIdentity(path.join(root, relative));

const verifiedStep = (
  sourceIdentity: TransferStep["sourceIdentity"],
  publishedIdentity: TransferStep["publishedIdentity"],
  step: Omit<TransferStep, "sourceIdentity" | "publishedIdentity" | "sidecars">
    & Partial<Pick<TransferStep, "sidecars">>,
): TransferStep => ({ sidecars: [], ...step, sourceIdentity, publishedIdentity });

test("resumeTransfer finishes a published record from what it says", async () => {
  await withRoot(["New/movie.mkv"], async (root, actions, calls) => {
    const identity = await identityAt(root, "New/movie.mkv");
    const step: TransferStep = verifiedStep(identity, identity, {
      phase: "published", copy: false,
      from: `${LIBRARY_ID}/Old/movie.mkv`, to: `${LIBRARY_ID}/New/movie.mkv`, carried: [],
    });
    assert.equal(await actions.resumeTransfer(step), step.to);
    // A replay only relocates when the source still holds rows or the destination does not.
    assert.deepEqual(calls.relocate, [{ from: step.from, to: step.to, pin: true }]);
    assert.equal(calls.invalidated, 1);
  });
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

test("empty parents are pruned deepest-first and a retained poster protects its ancestors", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "library-prune-"));
  const poster = Buffer.from([0x00, 0xff, 0x13, 0x37, 0x42]);
  try {
    await mkdir(path.join(root, "Show", "Unused", "Season", "Disc"), { recursive: true });
    await writeFile(path.join(root, "Show", "poster.jpg"), poster);
    const state = {
      version: 1,
      meta: {
        "Show/Unused/Season/Disc": { type: "movie" as const, id: "tt-unused", source: "user" as const, locked: true },
        Show: { type: "series" as const, id: "tt-show", source: "user" as const, locked: true },
      },
      suggestions: {},
    };
    const metaStore: LibraryActionDeps["metaStore"] = {
      qualifiedMeta: () => Object.fromEntries(Object.entries(state.meta).map(([key, value]) => [`${LIBRARY_ID}/${key}`, value])),
      update: async (_libraryId, mutate) => { mutate(state, {}); },
      relocate: async () => undefined,
      copy: async () => undefined,
      holds: () => false,
      flushLibrary: async () => undefined,
    };
    const { actions, calls } = harness({ libraries: () => [{ ...library, root }], metaStore });

    assert.deepEqual(
      await actions.pruneEmptiedFolders(`${LIBRARY_ID}/Show/Unused/Season/Disc/movie.mkv`),
      ["Show/Unused/Season/Disc", "Show/Unused/Season", "Show/Unused"],
    );
    assert.deepEqual(calls.cleared, [
      `${LIBRARY_ID}/Show/Unused/Season/Disc`,
      `${LIBRARY_ID}/Show/Unused/Season`,
      `${LIBRARY_ID}/Show/Unused`,
    ]);
    assert.deepEqual(Object.keys(state.meta), ["Show"], "state stays for the folder the poster retained");
    assert.equal(await exists(path.join(root, "Show")), true);
    assert.deepEqual(await readFile(path.join(root, "Show", "poster.jpg")), poster);
    assert.equal(await exists(root), true, "the library root is never an ancestor to remove");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("pruning stops at a carve-out and cannot escape the library root", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "library-prune-guard-"));
  try {
    await mkdir(path.join(root, "Inbox"), { recursive: true });
    const guarded = harness({
      libraries: () => [{ ...library, root }],
      carveOuts: new Set(["Inbox/Other Library"]),
    });
    assert.deepEqual(await guarded.actions.pruneEmptiedFolders(`${LIBRARY_ID}/Inbox/movie.mkv`), []);
    assert.equal(await exists(path.join(root, "Inbox")), true);
    assert.deepEqual(guarded.calls.cleared, []);

    const outside = harness({ libraries: () => [{ ...library, root }] });
    assert.deepEqual(await outside.actions.pruneEmptiedFolders(`${LIBRARY_ID}/../outside/movie.mkv`), []);
    assert.deepEqual(outside.calls.cleared, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("resumeTransfer never removes an unverified empty target", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "library-actions-"));
  try {
    await mkdir(path.join(root, "Old"));
    await mkdir(path.join(root, "New"));
    await writeFile(path.join(root, "Old/movie.mkv"), "video");
    await writeFile(path.join(root, "New/movie.mkv"), "");
    const { actions } = harness({ libraries: () => [{ ...library, root }] });
    const step: TransferStep = verifiedStep(await identityAt(root, "Old/movie.mkv"), null, {
      phase: "moving", copy: false,
      from: `${LIBRARY_ID}/Old/movie.mkv`, to: `${LIBRARY_ID}/New/movie.mkv`, carried: [],
    });
    await assert.rejects(actions.resumeTransfer(step), { messageKey: "err.libraryRecoveryConflict" });
    assert.equal(await exists(path.join(root, "New/movie.mkv")), true, "the unverified target is untouched");
    assert.equal(await exists(path.join(root, "Old/movie.mkv")), true, "the source is still there");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("resumeTransfer treats an inaccessible target as a conflict rather than a missing one", {
  skip: process.platform === "win32" ? "file modes are not enforced on NTFS"
    : process.getuid?.() === 0 ? "needs a user that write permission applies to" : false,
}, async () => {
  const root = await mkdtemp(path.join(tmpdir(), "library-actions-"));
  try {
    await mkdir(path.join(root, "Old"));
    await mkdir(path.join(root, "New"));
    await writeFile(path.join(root, "Old/movie.mkv"), "video");
    const { actions } = harness({ libraries: () => [{ ...library, root }] });
    const step = verifiedStep(await identityAt(root, "Old/movie.mkv"), null, {
      phase: "moving", copy: false,
      from: `${LIBRARY_ID}/Old/movie.mkv`, to: `${LIBRARY_ID}/New/movie.mkv`, carried: [],
    });
    await chmod(path.join(root, "New"), 0o000);
    await assert.rejects(actions.resumeTransfer(step), { messageKey: "err.libraryRecoveryConflict" });
    assert.equal(await readFile(path.join(root, "Old/movie.mkv"), "utf8"), "video");
  } finally {
    await chmod(path.join(root, "New"), 0o755).catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("resumeTransfer refuses when neither end holds the item", async () => {
  await withRoot(["reference.mkv"], async (root, actions) => {
    const step: TransferStep = verifiedStep(await identityAt(root, "reference.mkv"), null, {
      phase: "moving", copy: false,
      from: `${LIBRARY_ID}/Old/movie.mkv`, to: `${LIBRARY_ID}/New/movie.mkv`, carried: [],
    });
    await assert.rejects(actions.resumeTransfer(step), { messageKey: "err.libraryRecoveryConflict" });
  });
});

test("resumeTransfer carries recorded sidecars after the video landed and is repeatable", async () => {
  const from = `${LIBRARY_ID}/Old/movie.mkv`;
  const to = `${LIBRARY_ID}/New/movie.mkv`;
  await withRoot(["Old/movie.en.srt", "New/movie.mkv"], async (root, actions) => {
    const { journal } = recordingJournal();
    const identity = await identityAt(root, "New/movie.mkv");
    const step: TransferStep = verifiedStep(identity, identity, {
      phase: "moving", copy: false, from, to, carried: [],
      sidecars: [{ from: "movie.en.srt", to: "movie.en.srt", identity: await identityAt(root, "Old/movie.en.srt") }],
    });
    assert.equal(await actions.resumeTransfer(step, journal), to);
    assert.equal(await readFile(path.join(root, "New/movie.en.srt"), "utf8"), "Old/movie.en.srt");
    assert.equal(await readFile(path.join(root, "Old/movie.en.srt"), "utf8"), "Old/movie.en.srt", "the source subtitle is preserved");

    assert.equal(await actions.resumeTransfer(step, journal), to);
    assert.equal(await readFile(path.join(root, "New/movie.en.srt"), "utf8"), "Old/movie.en.srt");
    assert.equal(await readFile(path.join(root, "Old/movie.en.srt"), "utf8"), "Old/movie.en.srt");
  });
});

test("an old moving record without identities conflicts without touching its sidecars", async () => {
  const from = `${LIBRARY_ID}/Old/movie.mkv`;
  const to = `${LIBRARY_ID}/New/movie.mkv`;
  await withRoot(["Old/movie.en.srt", "New/movie.mkv"], async (root, actions) => {
    const step = { phase: "moving", copy: false, from, to, carried: [] } as unknown as TransferStep;
    await assert.rejects(actions.resumeTransfer(step), { messageKey: "err.libraryRecoveryConflict" });
    assert.equal(await exists(path.join(root, "New/movie.en.srt")), false);
    assert.equal(await readFile(path.join(root, "Old/movie.en.srt"), "utf8"), "Old/movie.en.srt");
  });
});

test("an old published record without identities conflicts", async () => {
  const from = `${LIBRARY_ID}/Old/movie.mkv`;
  const to = `${LIBRARY_ID}/New/movie.mkv`;
  await withRoot(["Old/movie.mp4", "Old/movie.srt", "New/movie.mkv"], async (root, actions) => {
    const step = { phase: "published", copy: false, from, to, carried: [] } as unknown as TransferStep;
    await assert.rejects(actions.resumeTransfer(step), { messageKey: "err.libraryRecoveryConflict" });
    assert.equal(await exists(path.join(root, "Old/movie.srt")), true);
    assert.equal(await exists(path.join(root, "New/movie.srt")), false);
  });
});

test("a replay never overwrites a subtitle already at the destination", async () => {
  const from = `${LIBRARY_ID}/Old/movie.mkv`;
  const to = `${LIBRARY_ID}/New/movie.mkv`;
  await withRoot(["Old/movie.srt", "New/movie.mkv", "New/movie.srt"], async (root, actions) => {
    const identity = await identityAt(root, "New/movie.mkv");
    const step: TransferStep = verifiedStep(identity, identity, {
      phase: "moving", copy: false, from, to, carried: [],
      sidecars: [{ from: "movie.srt", to: "movie.srt", identity: await identityAt(root, "Old/movie.srt") }],
    });
    assert.equal(await actions.resumeTransfer(step), to);
    assert.equal(await readFile(path.join(root, "New/movie.srt"), "utf8"), "New/movie.srt");
    assert.equal(await exists(path.join(root, "Old/movie.srt")), true);
  });
});

test("a replay leaves an empty destination subtitle in place", async () => {
  const from = `${LIBRARY_ID}/Old/movie.mkv`;
  const to = `${LIBRARY_ID}/New/movie.mkv`;
  await withRoot(["Old/movie.srt", "New/movie.mkv"], async (root, actions) => {
    await writeFile(path.join(root, "New/movie.srt"), "");
    const identity = await identityAt(root, "New/movie.mkv");
    const step: TransferStep = verifiedStep(identity, identity, {
      phase: "moving", copy: false, from, to, carried: [],
      sidecars: [{ from: "movie.srt", to: "movie.srt", identity: await identityAt(root, "Old/movie.srt") }],
    });
    assert.equal(await actions.resumeTransfer(step), to);
    assert.equal(await readFile(path.join(root, "New/movie.srt"), "utf8"), "");
    assert.equal(await readFile(path.join(root, "Old/movie.srt"), "utf8"), "Old/movie.srt");
  });
});

test("a copy replay leaves sidecars at both ends", async () => {
  const from = `${LIBRARY_ID}/Old/movie.mkv`;
  const to = `${LIBRARY_ID}/New/movie.mkv`;
  await withRoot(["Old/movie.mkv", "Old/movie.srt", "New/movie.mkv"], async (root, actions) => {
    const step: TransferStep = verifiedStep(
      await identityAt(root, "Old/movie.mkv"),
      await identityAt(root, "New/movie.mkv"),
      {
      phase: "moving", copy: true, from, to, carried: [],
      sidecars: [{ from: "movie.srt", to: "movie.srt", identity: await identityAt(root, "Old/movie.srt") }],
      },
    );
    assert.equal(await actions.resumeTransfer(step), to);
    assert.equal(await readFile(path.join(root, "Old/movie.srt"), "utf8"), "Old/movie.srt");
    assert.equal(await readFile(path.join(root, "New/movie.srt"), "utf8"), "Old/movie.srt");
  });
});

test("a replay carries only sidecars that have not already followed the video", async () => {
  const from = `${LIBRARY_ID}/Old/movie.mkv`;
  const to = `${LIBRARY_ID}/New/movie.mkv`;
  await withRoot(["Old/movie.cs.srt", "New/movie.en.srt", "New/movie.mkv"], async (root, actions) => {
    const identity = await identityAt(root, "New/movie.mkv");
    const step: TransferStep = verifiedStep(identity, identity, {
      phase: "moving", copy: false, from, to, carried: [],
      sidecars: [
        { from: "movie.en.srt", to: "movie.en.srt" },
        { from: "movie.cs.srt", to: "movie.cs.srt", identity: await identityAt(root, "Old/movie.cs.srt") },
      ],
    });
    assert.equal(await actions.resumeTransfer(step), to);
    assert.equal(await readFile(path.join(root, "New/movie.en.srt"), "utf8"), "New/movie.en.srt");
    assert.equal(await readFile(path.join(root, "New/movie.cs.srt"), "utf8"), "Old/movie.cs.srt");
    assert.equal(await readFile(path.join(root, "Old/movie.cs.srt"), "utf8"), "Old/movie.cs.srt");
  });
});

test("transferLibraryItem rejects journal sidecar names that leave their folders", async () => {
  await withRoot(["x.srt", "a/x.srt", "Old/a/b.srt", "New/movie.mkv"], async (root, actions) => {
    for (const name of ["../x.srt", "a/b.srt"]) {
      const { journal } = recordingJournal({
        phase: "moving", copy: false, carried: [],
        from: `${LIBRARY_ID}/Old/movie.mkv`, to: `${LIBRARY_ID}/New/movie.mkv`,
        sidecars: [{ from: name, to: "../carried.srt" }],
      });
      await assert.rejects(
        actions.transferLibraryItem(`${LIBRARY_ID}/Old/movie.mkv`, `${LIBRARY_ID}/New`, false, undefined, false, journal),
        { messageKey: "err.libraryRecoveryConflict" },
      );
    }
    assert.equal(await readFile(path.join(root, "x.srt"), "utf8"), "x.srt");
    assert.equal(await readFile(path.join(root, "a/x.srt"), "utf8"), "a/x.srt");
    assert.equal(await readFile(path.join(root, "Old/a/b.srt"), "utf8"), "Old/a/b.srt");
    assert.equal(await exists(path.join(root, "carried.srt")), false);
    assert.equal(await exists(path.join(root, "Old/a/carried.srt")), false);
  });
});

test("transferLibraryItem marks a video that is a title of its own, and only that", async () => {
  const loose = `${LIBRARY_ID}/Whisper Man/Harry Potter.mp4`;
  const units: TitleUnit[] = [
    { key: loose, relative: loose, kind: "movie", sampleFiles: [loose] },
    { key: `${LIBRARY_ID}/Heat`, relative: `${LIBRARY_ID}/Heat`, kind: "movie", sampleFiles: [`${LIBRARY_ID}/Heat/movie.mkv`] },
  ];
  await withRoot(["Whisper Man/Harry Potter.mp4", "Heat/movie.mkv", "Films/.keep"], async (_root, actions, calls) => {
    await actions.transferLibraryItem(loose, `${LIBRARY_ID}/Films`);
    await actions.transferLibraryItem(`${LIBRARY_ID}/Heat/movie.mkv`, `${LIBRARY_ID}/Films`);
    assert.deepEqual(calls.relocate.map(({ from, unit }) => ({ from, unit })), [
      { from: loose, unit: loose },
      // A file of a folder title keeps the folder's identity, as the library shows it.
      { from: `${LIBRARY_ID}/Heat/movie.mkv`, unit: undefined },
    ]);
  }, { units });
});

test("a transfer resumed from its journal after a crash keeps the loose film's own title", async () => {
  // The video landed in Films, then the server stopped before the metadata half ran.
  await withRoot(["Films/Harry Potter.mp4", "Whisper Man/.keep"], async (root, actions, calls) => {
    const identity = await identityAt(root, "Films/Harry Potter.mp4");
    const from = `${LIBRARY_ID}/Whisper Man/Harry Potter.mp4`;
    const { journal } = recordingJournal(verifiedStep(identity, identity, {
      phase: "published", copy: false, from, to: `${LIBRARY_ID}/Films/Harry Potter.mp4`, carried: [], unit: from,
    }));
    await actions.transferLibraryItem(from, `${LIBRARY_ID}/Films`, false, undefined, false, journal);
    assert.deepEqual(calls.relocate.map(({ from: source, unit }) => ({ from: source, unit })), [{ from, unit: from }]);
  });
});

test("a journal record whose title lies in another folder is refused", async () => {
  await withRoot(["Films/Harry Potter.mp4", "Whisper Man/.keep"], async (root, actions) => {
    const identity = await identityAt(root, "Films/Harry Potter.mp4");
    const from = `${LIBRARY_ID}/Whisper Man/Harry Potter.mp4`;
    const { journal } = recordingJournal(verifiedStep(identity, identity, {
      phase: "published", copy: false, from, to: `${LIBRARY_ID}/Films/Harry Potter.mp4`, carried: [], unit: `${LIBRARY_ID}/Other/Harry Potter.mp4`,
    }));
    await assert.rejects(actions.transferLibraryItem(from, `${LIBRARY_ID}/Films`, false, undefined, false, journal), { messageKey: "err.libraryRecoveryConflict" });
  });
});

test("a planned title survives the folder changing shape as other films leave", async () => {
  const arrival = `${LIBRARY_ID}/Mix/Arrival (2016).mkv`;
  const heat = `${LIBRARY_ID}/Mix/Heat (1995).mkv`;
  const heatHd = `${LIBRARY_ID}/Mix/Heat (1995) 1080p.mkv`;
  // Two films side by side are two titles keyed by their files; once Arrival has gone, the two
  // Heat files are the folder's only film and read as one title keyed by the folder.
  const before: TitleUnit[] = [
    { key: arrival, relative: arrival, kind: "movie", sampleFiles: [arrival] },
    { key: heat, relative: heat, kind: "movie", sampleFiles: [heat, heatHd] },
  ];
  const after: TitleUnit[] = [{ key: `${LIBRARY_ID}/Mix`, relative: `${LIBRARY_ID}/Mix`, kind: "movie", sampleFiles: [heat, heatHd] }];
  let units = before;
  await withRoot(["Mix/Arrival (2016).mkv", "Mix/Heat (1995).mkv", "Mix/Heat (1995) 1080p.mkv", "Films/.keep"], async (_root, actions, calls) => {
    await actions.transferLibraryItem(arrival, `${LIBRARY_ID}/Films`, false, undefined, false, undefined, arrival);
    units = after;
    await actions.transferLibraryItem(heatHd, `${LIBRARY_ID}/Films`, false, undefined, false, undefined, heat);
    await actions.transferLibraryItem(heat, `${LIBRARY_ID}/Films`, false, undefined, false, undefined, heat);
    assert.deepEqual(calls.relocate.map(({ from, unit }) => ({ from, unit })), [
      { from: arrival, unit: arrival },
      { from: heatHd, unit: heat },
      { from: heat, unit: heat },
    ], "each file keeps the title the plan saw, not the folder it became");
  }, { units: () => units });

  // Read again without the plan, the second Heat file would have been the folder's.
  units = after;
  await withRoot(["Mix/Heat (1995) 1080p.mkv", "Films/.keep"], async (_root, actions, calls) => {
    await actions.transferLibraryItem(heatHd, `${LIBRARY_ID}/Films`);
    assert.equal(calls.relocate[0]?.unit, undefined);
  }, { units: () => units });
});

test("a planned title in another folder is ignored", async () => {
  const film = `${LIBRARY_ID}/Mix/Heat (1995).mkv`;
  await withRoot(["Mix/Heat (1995).mkv", "Films/.keep"], async (_root, actions, calls) => {
    await actions.transferLibraryItem(film, `${LIBRARY_ID}/Films`, false, undefined, false, undefined, `${LIBRARY_ID}/Elsewhere/Heat (1995).mkv`);
    assert.equal(calls.relocate[0]?.unit, undefined);
  });
});

test("a replay rejects sidecar names that are not subtitles of the two videos", async () => {
  const from = `${LIBRARY_ID}/Old/movie.mkv`;
  const to = `${LIBRARY_ID}/New/movie.mkv`;
  await withRoot(["Old/other.mkv", "Old/other.srt", "Old/movie.srt", "New/movie.mkv"], async (root, actions) => {
    const identity = await identityAt(root, "New/movie.mkv");
    const step: TransferStep = verifiedStep(identity, identity, {
      phase: "moving", copy: false, from, to, carried: [],
      sidecars: [
        { from: "other.mkv", to: "movie.srt" },
        { from: "other.srt", to: "other.srt" },
        { from: "movie.srt", to: "stolen.mkv" },
      ],
    });
    await assert.rejects(actions.resumeTransfer(step), { messageKey: "err.libraryRecoveryConflict" });
    assert.equal(await exists(path.join(root, "Old/other.mkv")), true);
    assert.equal(await exists(path.join(root, "Old/other.srt")), true);
    assert.equal(await exists(path.join(root, "Old/movie.srt")), true);
    assert.equal(await exists(path.join(root, "New/movie.srt")), false);
    assert.equal(await exists(path.join(root, "New/stolen.mkv")), false);
  });
});

test("a failed metadata commit leaves the empty source folder and its artwork alone", async t => {
  const root = await mkdtemp(path.join(tmpdir(), "library-commit-"));
  const metaStore = new LibraryMetaStore(path.join(root, "data"));
  t.after(async () => { await metaStore.flush(); await rm(root, { recursive: true, force: true }); });
  await mkdir(path.join(root, "Old"));
  await metaStore.load();
  await metaStore.update(LIBRARY_ID, file => {
    file.meta["Old/movie.mkv"] = { type: "movie", id: "tt1", source: "user" };
  });
  await mkdir(path.join(root, "data", "library", `${LIBRARY_ID}.json.tmp`));
  const { actions, calls } = harness({ libraries: () => [{ ...library, root }], metaStore });
  const step = verifiedStep("a".repeat(64), null, {
    phase: "moving", copy: false, from: `${LIBRARY_ID}/Old/movie.mkv`, to: `${LIBRARY_ID}/New/movie.mkv`, carried: [],
  });
  await assert.rejects(actions.finishTransfer(step), { messageKey: "err.libraryMetadataWrite", status: 503 });
  assert.equal(await exists(path.join(root, "Old")), true);
  assert.deepEqual(calls.cleared, []);
});

test("cross-library finish and replay preserve a destination edited during the first commit", async t => {
  const dir = await mkdtemp(path.join(tmpdir(), "library-finish-replay-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const a = { ...library, root: path.join(dir, "A") };
  const b = { ...library, id: "lib_12345678", root: path.join(dir, "B") };
  const from = `${a.id}/Film.mkv`, to = `${b.id}/Film.mkv`;
  const dataDir = path.join(dir, "state");
  const store = new LibraryMetaStore(dataDir);
  await store.load();
  const original: LibraryMetaRecord = { type: "movie", id: "tt1", source: "user" };
  const edited = { ...original, id: "tt2" };
  await store.update(a.id, file => { file.meta["Film.mkv"] = original; });
  await store.flush();
  const commit = store.flushLibrary.bind(store);
  const edit = t.mock.method(store, "flushLibrary", async (id: string) => {
    edit.mock.restore();
    await commit(id);
    await store.update(b.id, file => { file.meta["Film.mkv"] = edited; });
  });
  const step = verifiedStep("a".repeat(64), "a".repeat(64), {
    from, to, phase: "published", copy: false, carried: [from],
  });
  const options = { libraries: () => [a, b] };
  const first = harness({ ...options, metaStore: store });
  await assert.rejects(first.actions.finishTransfer(step), { messageKey: "err.libraryRecoveryConflict" });
  assert.deepEqual(first.calls.moved, []);
  await store.flush();
  const reopened = new LibraryMetaStore(dataDir);
  await reopened.load();
  const replay = harness({ ...options, metaStore: reopened });
  await assert.rejects(replay.actions.finishTransfer(step, undefined, true), { messageKey: "err.libraryRecoveryConflict" });
  assert.deepEqual(reopened.qualifiedMeta()[to], edited);
  assert.deepEqual(reopened.qualifiedMeta()[from], original);
  assert.deepEqual(replay.calls.moved, []);
  await reopened.update(b.id, file => { file.meta["Film.mkv"] = original; });
  await replay.actions.finishTransfer(step, undefined, true);
  assert.equal(reopened.qualifiedMeta()[from], undefined);
  assert.deepEqual(reopened.qualifiedMeta()[to], original);
});

test("a cross-library hand move retries a failed commit before carrying artwork", async t => {
  const dir = await mkdtemp(path.join(tmpdir(), "library-hand-retry-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = new LibraryMetaStore(dir);
  await store.load();
  const other = "lib_12345678";
  const from = `${LIBRARY_ID}/Film`, to = `${other}/Film`;
  await store.update(LIBRARY_ID, file => { file.meta.Film = { type: "movie", id: "tt1", source: "user", locked: true }; });
  await store.flush();
  const blocker = path.join(dir, "library", `${other}.json.tmp`);
  await mkdir(blocker);
  const { actions, calls } = harness({ metaStore: store });
  await assert.rejects(actions.carryHandMove(from, to, false), { messageKey: "err.libraryMetadataWrite", status: 503 });
  assert.equal(calls.moved.length, 0);
  assert.deepEqual(calls.seenMoves, []);
  await rm(blocker, { recursive: true });
  await actions.carryHandMove(from, to, false);
  assert.equal(store.qualifiedMeta()[from], undefined);
  assert.equal(store.qualifiedMeta()[to]?.id, "tt1");
  assert.ok(calls.moved.includes(from));
  assert.equal(calls.seenMoves.length, 1);
  await store.flush();
});

test("a replayed finishTransfer leaves the destination's carried rows unpinned", async () => {
  const step: TransferStep = verifiedStep("a".repeat(64), null, {
    phase: "moving", copy: false,
    from: `${LIBRARY_ID}/Old/movie.mkv`, to: `${LIBRARY_ID}/New/movie.mkv`, carried: [],
  });
  const replayed = harness({ holds: (key) => key === step.to });
  assert.equal(await replayed.actions.finishTransfer(step, undefined, true), step.to);
  assert.deepEqual(replayed.calls.relocate, [], "the rows already at the destination are not pinned over");
  const fresh = harness();
  assert.equal(await fresh.actions.finishTransfer(step), step.to);
  assert.deepEqual(fresh.calls.relocate, [{ from: step.from, to: step.to, pin: true }]);
});

test("finishTransfer reads a loose film's identity by its own title, not the folder's", async () => {
  const step: TransferStep = verifiedStep("a".repeat(64), null, {
    phase: "moving", copy: false,
    from: `${LIBRARY_ID}/Whisper Man/Harry Potter.mp4`, to: `${LIBRARY_ID}/Films/Harry Potter.mp4`, carried: [],
    unit: `${LIBRARY_ID}/Whisper Man/Harry Potter.mp4`,
  });
  const run = harness();
  await run.actions.finishTransfer(step);
  assert.deepEqual(run.calls.relocate, [{ from: step.from, to: step.to, pin: true, unit: step.unit }]);
});

const withCarry = async (
  records: Record<string, LibraryMetaRecord>,
  files: string[],
  run: (
    root: string,
    actions: ReturnType<typeof createLibraryActions>,
    calls: ReturnType<typeof harness>["calls"],
    metaStore: LibraryMetaStore,
    seen: LibrarySeenStore,
    data: UserData,
  ) => Promise<void>,
  seenFiles = files,
  carryOptions: Parameters<typeof harness>[0] = {},
) => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "library-carry-"));
  try {
    const metaStore = new LibraryMetaStore(dataDir);
    await metaStore.load();
    await metaStore.update(LIBRARY_ID, (file) => { file.meta = records; });
    const seen = new LibrarySeenStore(dataDir);
    await seen.load();
    seen.observe(LIBRARY_ID, [], new Date("2026-01-01T00:00:00.000Z"));
    seen.observe(LIBRARY_ID, seenFiles.map((relative) => ({ relative, size: 1, modified: "2026-01-02T00:00:00.000Z" })),
      new Date("2026-02-01T00:00:00.000Z"));
    const data = {
      favorites: [`${LIBRARY_ID}/${seenFiles[0]}`],
      progress: {
        [`file:${LIBRARY_ID}/${seenFiles[0]}`]: {
          position: 10, duration: 100, title: "Test", path: `${LIBRARY_ID}/${seenFiles[0]}`, updatedAt: "2026-02-01T00:00:00.000Z",
        },
      },
      watchlist: {},
    } as UserData;
    await withRoot(files, (root, actions, calls) => run(root, actions, calls, metaStore, seen, data), {
      ...carryOptions,
      metaStore,
      seen,
      progressOf: (value) => value.progress as ReturnType<LibraryActionDeps["progressOf"]>,
      updateEveryData: async (mutate) => { mutate(data); },
    });
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
};

test("a split retry still identifies a version left behind by a name collision", async () => {
  const primary = "Shelf/Heat (1995) 1080p.mkv";
  const alternate = "Shelf/Heat (1995).mkv";
  const sourceFiles = [primary, alternate, "Shelf/Arrival.mkv"];
  const walk = (paths: string[]) => titleUnits(paths.map(relative => ({
    relative: `${LIBRARY_ID}/${relative}`, size: 1, modified: "",
  })));
  const planned = `${LIBRARY_ID}/${primary}`;
  const record: LibraryMetaRecord = { type: "movie", id: "tt-heat", name: "Heat", source: "user", locked: true };
  const target = `${LIBRARY_ID}/Films`;
  await withCarry({ [primary]: record }, [...sourceFiles, "Films/Heat (1995).mkv"], async (root, actions, _calls, metadata) => {
    await assert.rejects(actions.transferLibraryItem(`${LIBRARY_ID}/${alternate}`, target, false, undefined, true, undefined, planned), { messageKey: "err.nameTaken" });
    await actions.transferLibraryItem(planned, target, false, undefined, true, undefined, planned);

    const remaining = [];
    for (const file of sourceFiles) if (await exists(path.join(root, file))) remaining.push(file);
    assert.deepEqual(remaining, [alternate, "Shelf/Arrival.mkv"]);
    const retry = buildSplitPlan({ library, libraries: [library], healthOf: () => ({}), units: walk(remaining),
      records: metadata.qualifiedMeta(), downloadTargets: [], operationBusy: new Set(), topNames: ["Shelf", "Films"] });
    assert.deepEqual(metadata.qualifiedMeta()[`${LIBRARY_ID}/${alternate}`], record);
    assert.equal(retry.items.find(item => item.relative === alternate)?.basis, "identified");
    assert.equal(retry.items.find(item => item.relative === alternate)?.label, "Heat");
    assert.equal(retry.items.find(item => item.relative === "Shelf/Arrival.mkv")?.basis, "none");

    // Moving the other title changes the walk to a folder unit; retry still targets the colliding file.
    await actions.transferLibraryItem(`${LIBRARY_ID}/Shelf/Arrival.mkv`, target);
    const last = buildSplitPlan({ library, libraries: [library], healthOf: () => ({}), units: walk([alternate]),
      records: metadata.qualifiedMeta(), downloadTargets: [], operationBusy: new Set(), topNames: ["Shelf", "Films"] });
    assert.deepEqual(last.items.map(item => [item.relative, item.label, item.basis]), [[alternate, "Heat", "identified"]]);
    await rm(path.join(root, "Films/Heat (1995).mkv"));
    await actions.transferLibraryItem(last.items[0]!.key, target, false, undefined, true, undefined, last.items[0]!.key);
    assert.deepEqual(metadata.qualifiedMeta()[`${target}/Heat (1995).mkv`], record);
    assert.deepEqual(metadata.qualifiedMeta()[`${target}/Heat (1995) 1080p.mkv`], record);
  }, sourceFiles, { units: () => walk(sourceFiles) });
});

test("carryHandMove carries a file's match, favourite, progress, artwork and first-seen date", async () => {
  const from = `${LIBRARY_ID}/Old/movie.mkv`;
  const to = `${LIBRARY_ID}/New/movie.mkv`;
  await withCarry({
    "Old/movie.mkv": { type: "movie", id: "tt-source", source: "user", locked: true },
  }, ["Old/movie.mkv"], async (_root, actions, calls, metaStore, seen, data) => {
    await actions.carryHandMove(from, to, false);
    await Promise.all([metaStore.flush(), seen.flush()]);
    assert.equal(metaStore.qualifiedMeta()[to]?.id, "tt-source");
    assert.deepEqual(data.favorites, [to]);
    assert.deepEqual(Object.keys(data.progress as Record<string, unknown>), [`file:${to}`]);
    assert.ok(calls.moved.some((key) => key.includes(from)), "the file artwork was moved");
    assert.deepEqual(seen.recent([LIBRARY_ID], 10), [{
      libraryId: LIBRARY_ID, relative: "New/movie.mkv", at: "2026-02-01T00:00:00.000Z",
    }]);
  });
});

test("carryHandMove carries a folder's binding, directory and episode artwork, and every file record", async () => {
  const from = `${LIBRARY_ID}/Show`;
  const to = `${LIBRARY_ID}/Show 2`;
  const sourceFiles = ["Show/S1/e1.mkv", "Show/S1/e2.mkv"];
  const movedFiles = ["Show 2/S1/e1.mkv", "Show 2/S1/e2.mkv"];
  await withCarry({
    Show: { type: "series", id: "tt-show", source: "user", locked: true },
  }, movedFiles, async (_root, actions, calls, metaStore, seen, data) => {
    await actions.carryHandMove(from, to, true);
    await Promise.all([metaStore.flush(), seen.flush()]);
    assert.equal(metaStore.qualifiedMeta()[to]?.id, "tt-show");
    assert.deepEqual(data.favorites, [`${LIBRARY_ID}/Show 2/S1/e1.mkv`]);
    assert.deepEqual(Object.keys(data.progress as Record<string, unknown>), [`file:${LIBRARY_ID}/Show 2/S1/e1.mkv`]);
    assert.ok(calls.moved.some((key) => key.includes(`lib_ab12cd34/Show`)), "the folder and its files supplied artwork keys");
    assert.ok(calls.moved.some((key) => key.includes(`${from}/S1/e1.mkv`)), "the episode artwork uses its old source key");
    assert.ok(calls.moved.some((key) => key.includes(`dir:${from}`)), "the folder artwork is carried too");
    assert.equal(calls.moved.some((key) => key.includes("Show 2")), false, "sources are what the cache is asked to move");
    assert.deepEqual(seen.recent([LIBRARY_ID], 10).map((entry) => entry.relative), [
      "Show 2/S1/e1.mkv",
      "Show 2/S1/e2.mkv",
    ]);
  }, sourceFiles);
});

test("carryHandMove uses the pass files without reading libraryFiles again", async () => {
  const from = `${LIBRARY_ID}/Show`;
  const to = `${LIBRARY_ID}/Show 2`;
  const files = [`${to}/S1/e1.mkv`];
  const { actions, calls } = harness({ files: files.map((relative) => ({ relative })) });
  await actions.carryHandMove(from, to, true, files);
  assert.equal(calls.libraryFilesReads, 0);
  assert.ok(calls.moved.some((key) => key.includes(`${from}/S1/e1.mkv`)));
});

test("a failed carry leaves personal state for the next pass and still lets first-seen stamping run", async () => {
  const from = `${LIBRARY_ID}/Old/movie.mkv`;
  const to = `${LIBRARY_ID}/New/movie.mkv`;
  const pair: FingerprintPair = { libraryId: LIBRARY_ID, from: "Old/movie.mkv", toLibraryId: LIBRARY_ID, to: "New/movie.mkv", folder: false };
  await withCarry({
    "Old/movie.mkv": { type: "movie", id: "tt-source", source: "user", locked: true },
  }, ["Old/movie.mkv"], async (_root, actions, _calls, metaStore, seen, data) => {
    let attempt = 0;
    let observed = 0;
    const first = await carryMovePairs(
      [pair],
      async () => {
        attempt += 1;
        await metaStore.relocate(from, to, true);
        throw new Error("carry stopped");
      },
      async () => undefined,
      async () => { observed += 1; },
    );
    assert.deepEqual(first, { carried: 0, failed: 1 });
    assert.equal(attempt, 1);
    assert.equal(observed, 1, "a failed pair must not hold back first-seen stamping");
    assert.deepEqual(data.favorites, [from]);
    assert.deepEqual(seen.recent([LIBRARY_ID], 10).map((entry) => entry.relative), ["Old/movie.mkv"]);

    const second = await carryMovePairs(
      [pair],
      async () => { await actions.carryHandMove(from, to, false, [to]); },
      async () => undefined,
      async () => {
        seen.observe(LIBRARY_ID, [{ relative: "New/movie.mkv", size: 1, modified: "2026-01-02T00:00:00.000Z" }],
          new Date("2026-03-01T00:00:00.000Z"));
      },
    );
    assert.deepEqual(second, { carried: 1, failed: 0 });
    assert.deepEqual(data.favorites, [to]);
    assert.deepEqual(seen.recent([LIBRARY_ID], 10), [{
      libraryId: LIBRARY_ID, relative: "New/movie.mkv", at: "2026-02-01T00:00:00.000Z",
    }]);
  });
});

test("remapPersonalState keeps the later progress row and deduplicates favourites", async () => {
  const from = `${LIBRARY_ID}/Old/movie.mkv`;
  const to = `${LIBRARY_ID}/New/movie.mkv`;
  const updatedAt = "2026-02-01T00:00:00.000Z";
  const targetNewer = {
    favorites: [from, to, to],
    progress: {
      [`file:${from}`]: { position: 10, duration: 100, title: "Test", path: from, updatedAt: "2026-01-01T00:00:00.000Z" },
      [`file:${to}`]: { position: 90, duration: 100, title: "Test", path: to, updatedAt },
    },
  } as unknown as UserData;
  await harness({
    progressOf: (value) => value.progress as ReturnType<LibraryActionDeps["progressOf"]>,
    updateEveryData: async (mutate) => { mutate(targetNewer); },
  }).actions.remapPersonalState(from, to);
  assert.equal((targetNewer.progress as Record<string, { position: number }>)[`file:${to}`]?.position, 90);
  assert.deepEqual(targetNewer.favorites, [to]);

  const sourceNewer = {
    favorites: [to],
    progress: {
      [`file:${from}`]: { position: 90, duration: 100, title: "Test", path: from, updatedAt: "2026-03-01T00:00:00.000Z" },
      [`file:${to}`]: { position: 10, duration: 100, title: "Test", path: to, updatedAt },
    },
  } as unknown as UserData;
  await harness({
    progressOf: (value) => value.progress as ReturnType<LibraryActionDeps["progressOf"]>,
    updateEveryData: async (mutate) => { mutate(sourceNewer); },
  }).actions.remapPersonalState(from, to);
  assert.equal((sourceNewer.progress as Record<string, { position: number }>)[`file:${to}`]?.position, 90);

  const tied = {
    favorites: [to],
    progress: {
      [`file:${from}`]: { position: 10, duration: 100, title: "Test", path: from, updatedAt: "2026-03-01T00:00:00.000Z" },
      [`file:${to}`]: { position: 90, duration: 100, title: "Test", path: to, updatedAt: "2026-03-01T00:00:00.000Z" },
    },
  } as unknown as UserData;
  await harness({
    progressOf: (value) => value.progress as ReturnType<LibraryActionDeps["progressOf"]>,
    updateEveryData: async (mutate) => { mutate(tied); },
  }).actions.remapPersonalState(from, to);
  assert.equal((tied.progress as Record<string, { position: number }>)[`file:${to}`]?.position, 90);
});

test("carryHandMove replaces an automatic target row and keeps a manual one", async () => {
  const from = `${LIBRARY_ID}/Old/movie.mkv`;
  const to = `${LIBRARY_ID}/New/movie.mkv`;
  await withCarry({
    "Old/movie.mkv": { type: "movie", id: "tt-source", source: "user", locked: true },
    "New/movie.mkv": { type: "movie", id: "tt-auto", source: "scan", locked: false },
  }, ["Old/movie.mkv"], async (_root, actions, _calls, metaStore) => {
    await actions.carryHandMove(from, to, false);
    await metaStore.flush();
    assert.equal(metaStore.qualifiedMeta()[to]?.id, "tt-source");
  });

  await withCarry({
    "Old/movie.mkv": { type: "movie", id: "tt-source", source: "user", locked: true },
    "New/movie.mkv": { type: "movie", id: "tt-auto", locked: false },
  }, ["Old/movie.mkv"], async (_root, actions, _calls, metaStore) => {
    await actions.carryHandMove(from, to, false);
    await metaStore.flush();
    assert.equal(metaStore.qualifiedMeta()[to]?.id, "tt-source");
  });

  await withCarry({
    "Old/movie.mkv": { type: "movie", id: "tt-source", source: "user", locked: true },
    "New/movie.mkv": { type: "movie", id: "tt-manual", source: "user", locked: true },
  }, ["Old/movie.mkv"], async (_root, actions, _calls, metaStore) => {
    await actions.carryHandMove(from, to, false);
    await metaStore.flush();
    assert.equal(metaStore.qualifiedMeta()[to]?.id, "tt-manual");
  });
});

test("a carried replay of an in-app move keeps the moved file's own match and target artwork", async () => {
  const from = `${LIBRARY_ID}/Show/bonus.mkv`;
  const to = `${LIBRARY_ID}/Movies/bonus.mkv`;
  const artwork = new Map<string, string>();
  for (const variant of ART_VARIANTS) {
    artwork.set(artVariantKey(from, variant), "source-file");
    artwork.set(artVariantKey(`dir:${from}`, variant), "source-folder");
  }
  const artworks: LibraryActionDeps["artworks"] = {
    moveKey: async (source, target) => {
      if (!artwork.has(source)) return { carried: false, reason: "absent" };
      artwork.set(target, artwork.get(source)!);
      artwork.delete(source);
      return { carried: true };
    },
    copyKey: async () => ({ carried: true }),
  };
  await withCarry({
    Show: { type: "series", id: "tt-show", source: "user", locked: true },
    "Show/bonus.mkv": { type: "movie", id: "tt-movie", source: "scan", locked: false },
  }, ["Show/bonus.mkv", "Movies/.keep"], async (_root, actions, _calls, metaStore, seen, data) => {
    await actions.transferLibraryItem(from, `${LIBRARY_ID}/Movies`);
    seen.move(LIBRARY_ID, "Show/bonus.mkv", LIBRARY_ID, "Movies/bonus.mkv");
    await metaStore.flush();
    await seen.flush();

    const beforeMeta = structuredClone(metaStore.qualifiedMeta()[to]);
    const beforeArt = [...artwork].filter(([key]) => key.includes(to));
    const beforeFavorites = [...data.favorites];
    const beforeSeen = seen.recent([LIBRARY_ID], 10);
    assert.equal(beforeMeta?.id, "tt-movie");
    assert.ok(beforeArt.length > 0);

    await actions.carryHandMove(from, to, false);
    await metaStore.flush();
    await seen.flush();
    assert.deepEqual(metaStore.qualifiedMeta()[to], beforeMeta);
    assert.deepEqual([...artwork].filter(([key]) => key.includes(to)), beforeArt);
    assert.deepEqual(data.favorites, beforeFavorites);
    assert.deepEqual(seen.recent([LIBRARY_ID], 10), beforeSeen);
  }, ["Show/bonus.mkv"], { artworks });
});

const withRoot = async (
  files: string[],
  run: (root: string, actions: ReturnType<typeof createLibraryActions>, calls: ReturnType<typeof harness>["calls"]) => Promise<void>,
  options: Parameters<typeof harness>[0] = {},
) => {
  const root = await mkdtemp(path.join(tmpdir(), "library-actions-"));
  try {
    for (const file of files) {
      await mkdir(path.dirname(path.join(root, file)), { recursive: true });
      await writeFile(path.join(root, file), file);
    }
    const { actions, calls } = harness({
      ...options,
      libraries: () => [{ ...library, root }],
      files: files.map((relative) => ({ relative: `${LIBRARY_ID}/${relative}` })),
    });
    await run(root, actions, calls);
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

test("deleting a video prunes its empty parents and keeps a custom poster", async () => {
  const poster = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0x02]);
  await withRoot(["Films/Show/Season/movie.mkv", "Films/Show/poster.jpg"], async (root, actions) => {
    await writeFile(path.join(root, "Films/Show/poster.jpg"), poster);
    await actions.deleteLibraryItem(`${LIBRARY_ID}/Films/Show/Season/movie.mkv`);
    assert.equal(await exists(path.join(root, "Films/Show/Season")), false);
    assert.equal(await exists(path.join(root, "Films/Show")), true);
    assert.deepEqual(await readFile(path.join(root, "Films/Show/poster.jpg")), poster);
    assert.equal(await exists(root), true);
  });
});

test("deleting the requested folder stays explicit while its parent cleanup is conservative", async () => {
  await withRoot([
    "Films/Requested/Inner/movie.mkv",
    "Films/Requested/poster.jpg",
    "Films/unrelated.txt",
  ], async (root, actions) => {
    await actions.deleteLibraryItem(`${LIBRARY_ID}/Films/Requested`);
    assert.equal(await exists(path.join(root, "Films/Requested")), false, "the requested folder is still deleted recursively");
    assert.equal(await exists(path.join(root, "Films")), true, "the parent holding another file is retained");
    assert.equal(await exists(path.join(root, "Films/unrelated.txt")), true);
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

test("a video transfer records its subtitle sidecars before moving it", async () => {
  await withRoot(["Films/Heat.mkv", "Films/Heat.en.srt", "Archive/.keep"],
    async (root, actions) => {
      const subtitleIdentity = await identityAt(root, "Films/Heat.en.srt");
      const written: unknown[] = [];
      const sourceThere: boolean[] = [];
      const journal = {
        recorded: undefined,
        record: async (data: unknown) => { written.push(data); sourceThere.push(await exists(path.join(root, "Films/Heat.mkv"))); },
      };
      await actions.transferLibraryItem(`${LIBRARY_ID}/Films/Heat.mkv`, `${LIBRARY_ID}/Archive`, false, undefined, false, journal);
      assert.deepEqual((written[0] as TransferStep).sidecars, [{ from: "Heat.en.srt", to: "Heat.en.srt", identity: subtitleIdentity }]);
      assert.equal(sourceThere[0], true);
    });
});

test("a failed moving-journal write prevents a transfer before the source is touched", async () => {
  await withRoot(["Films/Heat.mkv", "Archive/.keep"], async (root, actions) => {
    const journal = {
      recorded: undefined,
      record: async () => { throw new Error("journal unavailable"); },
    };
    await assert.rejects(
      actions.transferLibraryItem(`${LIBRARY_ID}/Films/Heat.mkv`, `${LIBRARY_ID}/Archive`, false, undefined, false, journal),
      /journal unavailable/,
    );
    assert.equal(await readFile(path.join(root, "Films/Heat.mkv"), "utf8"), "Films/Heat.mkv");
    assert.equal(await exists(path.join(root, "Archive/Heat.mkv")), false);
  });
});

test("a failed re-root journal write prevents publication", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "library-actions-"));
  try {
    await mkdir(path.join(root, "Old/item"), { recursive: true });
    await mkdir(path.join(root, "New"), { recursive: true });
    await writeFile(path.join(root, "Old/item/movie.mkv"), "video");
    const { actions } = harness({ libraries: () => [{ ...library, root }] });
    const journal = {
      recorded: undefined,
      record: async () => { throw new Error("journal unavailable"); },
    };
    await assert.rejects(
      actions.rerootItem(
        { op: "reroot", items: ["item"], libraryId: LIBRARY_ID, from: path.join(root, "Old"), to: path.join(root, "New") },
        "item",
        () => undefined,
        journal,
      ),
      /journal unavailable/,
    );
    assert.equal(await readFile(path.join(root, "Old/item/movie.mkv"), "utf8"), "video");
    assert.equal(await exists(path.join(root, "New/item")), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a cross-filesystem move preserves a source replaced after staging", { skip: process.platform !== "linux" }, async (t) => {
  const sourceRoot = await mkdtemp(path.join(tmpdir(), "library-source-"));
  t.after(() => rm(sourceRoot, { recursive: true, force: true }));
  const targetRoot = await mkdtemp("/dev/shm/library-target-");
  t.after(() => rm(targetRoot, { recursive: true, force: true }));
  if ((await stat(sourceRoot)).dev === (await stat(targetRoot)).dev) return t.skip("requires two filesystems");
  const source = path.join(sourceRoot, "movie.mkv");
  const target = path.join(targetRoot, "movie.mkv");
  await writeFile(source, "original");
  const archive = { ...library, id: "lib_1234abcd", root: targetRoot };
  const { actions, calls } = harness({ libraries: () => [{ ...library, root: sourceRoot }, archive] });
  const journal = {
    recorded: undefined,
    record: async (data: unknown) => {
      const step = data as TransferStep;
      if (step.phase === "moving" && step.publishedIdentity) {
        await rm(source);
        await writeFile(source, "new file");
      }
    },
  };
  await assert.rejects(actions.transferLibraryItem(`${library.id}/movie.mkv`, archive.id, false, undefined, false, journal),
    { messageKey: "err.libraryRecoveryConflict" });
  assert.equal(await readFile(source, "utf8"), "new file");
  assert.equal(await readFile(target, "utf8"), "original");
  assert.deepEqual(calls.relocate, []);
});

test("a changed episode inside a published directory stops recovery before remapping", async () => {
  await withRoot(["New/Show/Season/movie.mkv"], async (root, actions, calls) => {
    const identity = await identityAt(root, "New/Show");
    await writeFile(path.join(root, "New/Show/Season/movie.mkv"), "replaced episode");
    const step = verifiedStep(identity, identity, {
      phase: "published", copy: false, from: `${LIBRARY_ID}/Old/Show`, to: `${LIBRARY_ID}/New/Show`, carried: [],
    });
    await assert.rejects(actions.resumeTransfer(step), { messageKey: "err.libraryRecoveryConflict" });
    assert.deepEqual(calls.relocate, []);
  });
});

test("a real copy records the source and completed staged object before publication", async () => {
  await withRoot(["Films/Heat.mkv", "Archive/.keep"], async (root, actions) => {
    const written: TransferStep[] = [];
    const targetDuringWrite: boolean[] = [];
    const journal = {
      recorded: undefined,
      record: async (data: unknown) => {
        written.push(structuredClone(data) as TransferStep);
        targetDuringWrite.push(await exists(path.join(root, "Archive/Heat.mkv")));
      },
    };
    await actions.transferLibraryItem(`${LIBRARY_ID}/Films/Heat.mkv`, `${LIBRARY_ID}/Archive`, true, undefined, false, journal);
    assert.equal(written[0]?.phase, "moving");
    assert.equal(written[0]?.publishedIdentity, null);
    assert.deepEqual(written[0]?.sourceIdentity, await identityAt(root, "Films/Heat.mkv"));
    const staged = written[1];
    assert.equal(staged?.phase, "moving");
    assert.ok(staged?.publishedIdentity, "the completed staged object is recorded");
    assert.deepEqual(staged?.publishedIdentity, await identityAt(root, "Archive/Heat.mkv"));
    assert.deepEqual(staged?.sourceIdentity, written[0]?.sourceIdentity, "publication keeps the source proof");
    assert.equal(targetDuringWrite[1], false, "the proof was written before the target name was published");
    assert.deepEqual(written.at(-1)?.publishedIdentity, staged?.publishedIdentity, "the final record keeps the publication proof");
  });
});

test("a folder transfer records an empty sidecar list", async () => {
  const { journal, written } = recordingJournal();
  await withRoot(["Films/Heat/Heat.mkv", "Films/Heat/Heat.srt", "Archive/.keep"],
    async (_root, actions) => {
      await actions.transferLibraryItem(`${LIBRARY_ID}/Films/Heat`, `${LIBRARY_ID}/Archive`, false, undefined, false, journal);
      assert.deepEqual((written[0] as TransferStep).sidecars, []);
    });
});

test("a first run leaves an empty subtitle at the destination alone", async () => {
  await withRoot(["Films/Heat.mkv", "Films/Heat.srt", "Archive/.keep"], async (root, actions) => {
    await writeFile(path.join(root, "Archive/Heat.srt"), "");
    await actions.transferLibraryItem(`${LIBRARY_ID}/Films/Heat.mkv`, `${LIBRARY_ID}/Archive`);
    assert.equal(await readFile(path.join(root, "Archive/Heat.srt"), "utf8"), "");
    assert.equal(await exists(path.join(root, "Films/Heat.srt")), true);
  });
});
