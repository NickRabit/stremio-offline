import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { createLibraryPathBusy, createLibraryPathsBusy, libraryWriting, type LibraryBusyDeps } from "./library-busy.js";
import type { LibraryRecord } from "./libraries.js";

const library = (id: string, root: string): LibraryRecord =>
  ({ id, name: id, type: "movie", root, enabled: true, order: 0, addedAt: "2026-01-01T00:00:00.000Z", writeArtwork: false });

const workspace = async (t: TestContext) => {
  const root = await mkdtemp(path.join(tmpdir(), "library-busy-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
};

type BusyState = Partial<{
  queued: string[]; roots: string[]; held: string[]; journaled: string[]; unreadable: boolean; folds: boolean;
  conflicts: (keys: readonly string[]) => boolean;
}>;

const depsFor = (libraries: LibraryRecord[], state: BusyState): LibraryBusyDeps => ({
  libraries: () => libraries,
  caseInsensitive: () => state.folds ?? false,
  queuedItems: () => state.queued ?? [],
  rerootRoots: () => state.roots ?? [],
  heldKeys: () => state.held ?? [],
  renames: {
    hasUnreadableRecord: () => state.unreadable ?? false,
    busyKeys: () => state.journaled ?? [],
    conflicts: state.conflicts ?? ((keys) => keys.some((key) => (state.journaled ?? []).includes(key))),
  },
});

const busyWith = (libraries: LibraryRecord[], state: BusyState) => {
  return createLibraryPathBusy(depsFor(libraries, state));
};

test("nothing active answers free without touching the disk", async () => {
  assert.equal(await busyWith([library("lib_00000001", "/does/not/exist")], {})(["lib_00000001/Films/Heat.mkv"]), undefined);
});

test("a file queued through the parent library is busy through the nested one", async (t) => {
  const root = await workspace(t);
  await mkdir(path.join(root, "Nested"), { recursive: true });
  const libraries = [library("lib_00000001", root), library("lib_00000002", path.join(root, "Nested"))];
  const busy = busyWith(libraries, { queued: ["lib_00000001/Nested/Heat.mkv"] });
  assert.equal(await busy(["lib_00000002/Heat.mkv"]), "lib_00000001/Nested/Heat.mkv");
  assert.equal(await busy(["lib_00000002/Thief.mkv"]), undefined);
});

test("a file held through a root typed through a symlink is busy through the real one", async (t) => {
  const root = await workspace(t);
  await mkdir(path.join(root, "Real"), { recursive: true });
  await symlink(path.join(root, "Real"), path.join(root, "Alias"), "dir");
  const libraries = [library("lib_00000001", path.join(root, "Real")), library("lib_00000002", path.join(root, "Alias"))];
  const busy = busyWith(libraries, { held: ["lib_00000002/Heat.mkv"] });
  assert.equal(await busy(["lib_00000001/Heat.mkv"]), "lib_00000002/Heat.mkv");
});

test("held names are skipped when the caller already holds them", async (t) => {
  const root = await workspace(t);
  const busy = busyWith([library("lib_00000001", root)], { held: ["lib_00000001/Heat.mkv"] });
  assert.equal(await busy(["lib_00000001/Heat.mkv"]), "lib_00000001/Heat.mkv");
  assert.equal(await busy(["lib_00000001/Heat.mkv"], { ignoreReservations: true }), undefined);
});

test("a re-root's destination folder inside another library is busy", async (t) => {
  const root = await workspace(t);
  await mkdir(path.join(root, "old"), { recursive: true });
  await mkdir(path.join(root, "other", "Incoming"), { recursive: true });
  const libraries = [library("lib_00000001", path.join(root, "old")), library("lib_00000002", path.join(root, "other"))];
  const to = path.join(root, "other", "Incoming");
  const busy = busyWith(libraries, { roots: [path.join(root, "old"), to] });
  assert.equal(await busy(["lib_00000002/Incoming/Show"]), to);
  assert.equal(await busy(["lib_00000002/Elsewhere"]), undefined);
});

test("a subtitle is busy while its video is queued", async (t) => {
  const root = await workspace(t);
  const busy = busyWith([library("lib_00000001", root)], { queued: ["lib_00000001/Films/Heat.mkv"] });
  assert.equal(await busy(["lib_00000001/Films/Heat.en.srt"]), "lib_00000001/Films/Heat.mkv");
  assert.equal(await busy(["lib_00000001/Films/Heat 2.mkv"]), undefined);
});

test("a folder link is busy while something works on a file reached through it", async (t) => {
  const root = await workspace(t);
  await mkdir(path.join(root, "Real"), { recursive: true });
  await writeFile(path.join(root, "Real", "Heat.mkv"), "video");
  await symlink(path.join(root, "Real"), path.join(root, "Alias"), "dir");
  const busy = busyWith([library("lib_00000001", root)], { held: ["lib_00000001/Alias/Heat.mkv"] });
  assert.equal(await busy(["lib_00000001/Alias"]), "lib_00000001/Alias/Heat.mkv");
  assert.equal(await busy(["lib_00000001/Alias/Thief.mkv"]), undefined);
});

test("names that differ in case are one place only where the volume folds case", async (t) => {
  const root = await workspace(t);
  const libraries = [library("lib_00000001", root)];
  assert.equal(await busyWith(libraries, { held: ["lib_00000001/Archive"], folds: true })(["lib_00000001/archive/Heat.mkv"]), "lib_00000001/Archive");
  assert.equal(await busyWith(libraries, { held: ["lib_00000001/Archive"], folds: false })(["lib_00000001/archive/Heat.mkv"]), undefined);
});

test("a journaled rename and an unreadable journal both make a request wait", async (t) => {
  const root = await workspace(t);
  const libraries = [library("lib_00000001", root)];
  assert.equal(await busyWith(libraries, { journaled: ["lib_00000001/Heat.mkv"] })(["lib_00000001/Heat.mkv"]), "lib_00000001/Heat.mkv");
  assert.equal(await busyWith(libraries, { journaled: ["lib_00000001/Films"] })(["lib_00000001/Films/Heat.mkv"]), "lib_00000001/Films");
  assert.equal(await busyWith(libraries, { unreadable: true })(["lib_00000001/Heat.mkv"]), "rename");
});

test("the journal's own answer counts even for a name the busy check cannot resolve", async (t) => {
  const root = await workspace(t);
  // A journaled name in a library that is gone from the list resolves to nothing, so only the
  // journal itself can say the requested key is one of its names.
  const busy = busyWith([library("lib_00000001", root)], {
    journaled: ["lib_00000009/Heat.mkv"],
    conflicts: (keys) => keys.includes("lib_00000001/Heat.mkv"),
  });
  assert.equal(await busy(["lib_00000001/Heat.mkv"]), "lib_00000001/Heat.mkv");
  assert.equal(await busy(["lib_00000001/Thief.mkv"]), undefined);
});

test("a direct request holding a path counts as a library write, as the queue's item does", () => {
  assert.equal(libraryWriting(false, []), false);
  assert.equal(libraryWriting(true, []), true);
  assert.equal(libraryWriting(false, ["lib_00000001/Films/Heat.mkv"]), true);
});

test("many keys are judged against one resolution of the queue", async (t) => {
  const root = await workspace(t);
  await mkdir(path.join(root, "Films"), { recursive: true });
  const libraries = [library("lib_00000001", root)];
  let reads = 0;
  const deps = depsFor(libraries, { queued: ["lib_00000001/Films/Heat", "lib_00000001/Films/Thief"] });
  const queuedItems = deps.queuedItems;
  deps.queuedItems = () => { reads += 1; return queuedItems(); };
  const busy = await createLibraryPathsBusy(deps)(["lib_00000001/Films/Heat", "lib_00000001/Films/Ronin", "lib_00000001/Films", "lib_00000001/Films/Thief/Thief.mkv"]);
  assert.deepEqual([...busy].sort(), ["lib_00000001/Films", "lib_00000001/Films/Heat", "lib_00000001/Films/Thief/Thief.mkv"]);
  assert.equal(reads, 1);
});

test("an unreadable rename record makes every asked key busy, and an idle queue none", async () => {
  const libraries = [library("lib_00000001", "/does/not/exist")];
  assert.deepEqual([...await createLibraryPathsBusy(depsFor(libraries, { unreadable: true }))(["lib_00000001/A", "lib_00000001/B"])], ["lib_00000001/A", "lib_00000001/B"]);
  assert.equal((await createLibraryPathsBusy(depsFor(libraries, {}))(["lib_00000001/A"])).size, 0);
});
