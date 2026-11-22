import assert from "node:assert/strict";
import { createHook } from "node:async_hooks";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { describePath, heldTree, isPathWithin, listVideos, walkLibrary, type FoundFile, type HeldTree } from "./library.js";
import { libraryPath, parseLibraryPath } from "./libraries.js";
import { WalkCache } from "./walk-cache.js";

const file = (relative: string, size: number, modified = "2026-01-01T00:00:00.000Z"): FoundFile => ({ relative, size, modified });

const relativeKeyIn = (libraryId: string, key: string) => {
  if (!libraryId) return key;
  const parsed = parseLibraryPath(key);
  return parsed?.libraryId === libraryId ? parsed.relative : undefined;
};

const filesIn = (files: readonly FoundFile[], libraryId: string): FoundFile[] =>
  files.flatMap((entry) => {
    const relative = relativeKeyIn(libraryId, entry.relative);
    return relative === undefined ? [] : [{ ...entry, relative }];
  });

const filesInside = (files: readonly FoundFile[], libraryId: string, relative: string) => async () =>
  files.flatMap((entry) => {
    const inside = relativeKeyIn(libraryId, entry.relative);
    return inside !== undefined && inside !== relative && isPathWithin(inside, relative)
      ? [{ ...entry, relative: inside }]
      : [];
  });

async function filesystemRequests<T>(run: () => Promise<T>): Promise<{ result: T; requests: number }> {
  let requests = 0;
  const hook = createHook({ init: (_asyncId, type) => { if (type === "FSREQPROMISE") requests += 1; } });
  hook.enable();
  try {
    return { result: await run(), requests };
  } finally {
    hook.disable();
  }
}

test("50 warm favourite folders use held aggregates without scanning the global walk", async (t) => {
  const base = await mkdtemp(path.join(tmpdir(), "stremio-held-favourites-"));
  const libraries = [
    { id: "lib_00000001", root: path.join(base, "one"), favorites: [] as string[] },
    { id: "lib_00000002", root: path.join(base, "two"), favorites: [] as string[] },
  ];
  try {
    await Promise.all(libraries.map((library) => mkdir(library.root, { recursive: true })));
    const walk: FoundFile[] = [];
    const tasks: Array<{ libraryId: string; root: string; relative: string }> = [];
    for (let index = 0; index < 50; index += 1) {
      const library = libraries[index % 2]!;
      const relative = index === 0 || index === 25 ? "Show" : `Favorite ${index}`;
      const folder = path.join(library.root, relative);
      await mkdir(folder, { recursive: true });
      await writeFile(path.join(folder, "disk.mkv"), Buffer.alloc(1));
      library.favorites.push(relative);
      tasks.push({ libraryId: library.id, root: library.root, relative });
      walk.push(file(
        libraryPath(library.id, `${relative}/held.mkv`),
        1_000 + index,
        `2026-02-${String((index % 27) + 1).padStart(2, "0")}T00:00:00.000Z`,
      ));
    }
    for (let index = 0; walk.length < 20_000; index += 1) {
      const library = libraries[index % 2]!;
      walk.push(file(
        libraryPath(library.id, `Bulk/${Math.floor(index / 100)}/video-${index}.mkv`),
        10_000 + index,
        `2026-03-${String((index % 27) + 1).padStart(2, "0")}T00:00:00.000Z`,
      ));
    }
    assert.equal(walk.length, 20_000);

    const trees = new Map(libraries.map((library) => [library.id, heldTree(filesIn(walk, library.id))]));
    for (const task of tasks.slice(0, 2)) {
      await describePath(task.root, task.relative, undefined, undefined, async () => trees.get(task.libraryId)!.folder(task.relative));
    }

    let walkVisits = 0;
    const observedWalk = new Proxy(walk, {
      get(target, property, receiver) {
        if (typeof property === "string" && /^\d+$/.test(property)) walkVisits += 1;
        return Reflect.get(target, property, receiver);
      },
    });
    let fallbackCalls = 0;
    const oldStarted = performance.now();
    const oldPage = await filesystemRequests(async () => {
      const items = [];
      for (const task of tasks) {
        fallbackCalls += 1;
        items.push(await describePath(task.root, task.relative, undefined, filesInside(observedWalk, task.libraryId, task.relative)));
      }
      return items;
    });
    const oldMs = performance.now() - oldStarted;
    assert.equal(fallbackCalls, 50);
    assert.equal(walkVisits, 50 * walk.length);

    fallbackCalls = 0;
    walkVisits = 0;
    const newStarted = performance.now();
    const newPage = await filesystemRequests(async () => {
      const items = [];
      for (const task of tasks) {
        items.push(await describePath(
          task.root,
          task.relative,
          undefined,
          async () => { fallbackCalls += 1; return []; },
          async () => trees.get(task.libraryId)!.folder(task.relative),
        ));
      }
      return items;
    });
    const newMs = performance.now() - newStarted;

    assert.equal(fallbackCalls, 0);
    assert.equal(walkVisits, 0);
    assert.deepEqual(newPage.result, oldPage.result);
    assert.equal(newPage.result.length, 50);
    assert.deepEqual(Object.keys(newPage.result[0]!), ["kind", "path", "name", "fileCount", "size", "modified"]);
    assert.equal(newPage.requests, oldPage.requests, "the held aggregate adds no filesystem requests");
    t.diagnostic(
      `warm favourites: old=${oldMs.toFixed(1)}ms new=${newMs.toFixed(1)}ms `
      + `walkVisits=${50 * walk.length}->0 fsRequests=${oldPage.requests}->${newPage.requests}`,
    );
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("held aggregates match fallback results across libraries, exclusions and missing folders", async () => {
  const base = await mkdtemp(path.join(tmpdir(), "stremio-held-equivalence-"));
  try {
    const rootA = path.join(base, "one");
    const rootB = path.join(base, "two");
    await Promise.all([mkdir(path.join(rootA, "Show"), { recursive: true }), mkdir(path.join(rootB, "Show"), { recursive: true })]);
    await Promise.all([
      writeFile(path.join(rootA, "Show", "one.mkv"), Buffer.alloc(1)),
      writeFile(path.join(rootB, "Show", "two.mkv"), Buffer.alloc(2)),
      mkdir(path.join(rootA, "Empty"), { recursive: true }),
    ]);
    const filesA = [file("Show/one.mkv", 101, "2026-04-01T00:00:00.000Z")];
    const filesB = [file("Show/two.mkv", 202, "2026-05-01T00:00:00.000Z")];
    for (const [root, files] of [[rootA, filesA], [rootB, filesB]] as const) {
      const held = heldTree(files);
      const oldItem = await describePath(root, "Show", undefined, async () => files);
      const newItem = await describePath(root, "Show", undefined, async () => { throw new Error("fallback used"); }, async () => held.folder("Show"));
      assert.deepEqual(newItem, oldItem);
    }

    const parent = path.join(base, "parent");
    const nested = path.join(parent, "Collection", "Nested Library");
    await Promise.all([
      mkdir(path.join(parent, "Collection"), { recursive: true }),
      mkdir(nested, { recursive: true }),
    ]);
    await Promise.all([
      writeFile(path.join(parent, "Collection", "outside.mkv"), Buffer.alloc(3)),
      writeFile(path.join(nested, "inside.mkv"), Buffer.alloc(30)),
    ]);
    const exclude = new Set(["Collection/Nested Library"]);
    const parentWalk = await walkLibrary(parent, exclude);
    assert.deepEqual(parentWalk.files.map((entry) => entry.relative), ["Collection/outside.mkv"]);
    const parentTree = heldTree(parentWalk.files, parentWalk.cut);
    assert.deepEqual(parentTree.folder("Collection"), {
      fileCount: 1, size: 3, modified: parentWalk.files[0]!.modified,
    });
    assert.deepEqual(
      await describePath(parent, "Collection", exclude, filesInside(parentWalk.files, "", "Collection"), async () => parentTree.folder("Collection")),
      await describePath(parent, "Collection", exclude, filesInside(parentWalk.files, "", "Collection")),
    );

    let deletedAggregateCalls = 0;
    assert.equal(await describePath(rootA, "Deleted", undefined, undefined, async () => {
      deletedAggregateCalls += 1;
      return { fileCount: 1, size: 1, modified: "2026-01-01T00:00:00.000Z" };
    }), undefined);
    assert.equal(deletedAggregateCalls, 0);
    const emptyTree = heldTree([]);
    assert.equal(await describePath(rootA, "Empty", undefined, undefined, async () => emptyTree.folder("Empty")), undefined);
    assert.equal(await describePath(rootA, "Empty"), undefined);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("a folder cut by the walk's depth cap falls back to the disk aggregate", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "stremio-held-depth-"));
  try {
    const eighth = path.join(root, "Deep", "1", "2", "3", "4", "5", "6", "7");
    await mkdir(path.join(eighth, "8"), { recursive: true });
    await writeFile(path.join(eighth, "near.mkv"), Buffer.alloc(4));
    await writeFile(path.join(eighth, "8", "far.mkv"), Buffer.alloc(7));
    const walk = await walkLibrary(root);
    const held = heldTree(walk.files, walk.cut);
    assert.equal(held.folder("Deep"), undefined);

    const diskFallback = async () => {
      const cut = walk.cut.some((folder) => isPathWithin(folder, "Deep") || isPathWithin("Deep", folder));
      return cut ? listVideos(root, "Deep") : walk.files.filter((entry) => isPathWithin(entry.relative, "Deep"));
    };
    const oldItem = await describePath(root, "Deep", undefined, diskFallback);
    const newItem = await describePath(root, "Deep", undefined, diskFallback, async () => held.folder("Deep"));
    assert.deepEqual(newItem, oldItem);
    assert.ok(newItem?.kind === "folder");
    assert.deepEqual({ fileCount: newItem.fileCount, size: newItem.size }, { fileCount: 2, size: 11 });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("invalidating the walk rebuilds the held aggregate with the changed file size", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "stremio-held-invalidate-"));
  try {
    const folder = path.join(root, "Film");
    const target = path.join(folder, "inside.mkv");
    await mkdir(folder, { recursive: true });
    await writeFile(target, Buffer.alloc(5));

    const cache = new WalkCache(() => walkLibrary(root), 30_000);
    const trees = new WeakMap<FoundFile[], HeldTree>();
    const describe = async () => {
      const walk = await cache.get({ stale: true });
      let held = trees.get(walk.files);
      if (!held) {
        held = heldTree(walk.files, walk.cut);
        trees.set(walk.files, held);
      }
      return describePath(root, "Film", undefined, async () => walk.files, async () => held.folder("Film"));
    };

    const before = await describe();
    assert.ok(before?.kind === "folder");
    assert.equal(before.size, 5);
    await writeFile(target, Buffer.alloc(9));
    const stale = await describe();
    assert.ok(stale?.kind === "folder");
    assert.equal(stale.size, 5);
    cache.invalidate();
    const fresh = await describe();
    assert.ok(fresh?.kind === "folder");
    assert.equal(fresh.size, 9);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
