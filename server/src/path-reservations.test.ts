import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { placed, resolveLibraryPath, type LibraryRecord } from "./libraries.js";
import type { LibraryOp } from "./library-ops.js";
import { destinationOf, PathReservations, placesOverlap, queuedItemPaths, reservationPause, type HeldPath } from "./path-reservations.js";

const resolvePlaced = async (libraries: LibraryRecord[], key: string) => {
  const resolved = await resolveLibraryPath(libraries, key);
  return resolved && placed(resolved);
};

const libraryAt = (id: string, root: string): LibraryRecord => ({ id, name: id, type: "movie", root, enabled: true, order: 0, addedAt: "2026-01-01T00:00:00.000Z", writeArtwork: true });

// The parent library at /media, a nested one at /media/Nested: two keys, one place on disk.
const at = (key: string): HeldPath => {
  const [id, ...rest] = key.split("/");
  const root = id === "lib_00000002" ? "/media/Nested" : "/media";
  return { key, absolute: path.join(root, ...rest) };
};

test("a held path refuses itself, anything inside it and anything around it until released", () => {
  const reservations = new PathReservations();
  const release = reservations.reserve([at("lib_00000001/Films/Heat.mkv"), at("lib_00000001/Films/Thief.mkv")]);
  assert.ok(release);
  assert.deepEqual(reservations.keys(), ["lib_00000001/Films/Heat.mkv", "lib_00000001/Films/Thief.mkv"]);

  assert.equal(reservations.reserve([at("lib_00000001/Films/Thief.mkv"), at("lib_00000001/Films/Ronin.mkv")]), undefined, "the same name");
  assert.equal(reservations.reserve([at("lib_00000001/Films")]), undefined, "the folder around it");
  assert.equal(reservations.reserve([at("lib_00000001/films/HEAT.mkv")]), undefined, "another case of the same name");
  assert.deepEqual(reservations.keys(), ["lib_00000001/Films/Heat.mkv", "lib_00000001/Films/Thief.mkv"], "a refused request holds nothing");

  const sibling = reservations.reserve([at("lib_00000001/Films/Heat 2.mkv")]);
  assert.ok(sibling, "a sibling whose name only starts the same is free");
  sibling();

  release();
  assert.deepEqual(reservations.keys(), []);
  assert.ok(reservations.reserve([at("lib_00000001/Films/Thief.mkv")]));
});

test("a file of a nested library is one place whichever library's key names it", () => {
  const reservations = new PathReservations();
  const release = reservations.reserve([at("lib_00000001/Nested/Heat.mkv")])!;
  assert.equal(reservations.reserve([at("lib_00000002/Heat.mkv")]), undefined, "the nested library's key for the same file");
  assert.equal(reservations.overlaps([at("lib_00000002/Heat.mkv")]), true);
  release();
  const nested = reservations.reserve([at("lib_00000002")])!;
  assert.equal(reservations.overlaps([at("lib_00000001/Nested/Season 1/01.mkv")]), true, "the parent's key inside the nested root");
  nested();
});

test("overlaps answers for a held path, its folder and another case, without holding anything", () => {
  const reservations = new PathReservations();
  assert.equal(reservations.overlaps([at("lib_00000001/Films/Heat.mkv")]), false);
  const release = reservations.reserve([at("lib_00000001/Films/Heat.mkv")])!;
  assert.equal(reservations.overlaps([at("lib_00000001/Films/Heat.mkv")]), true);
  assert.equal(reservations.overlaps([at("lib_00000001/Films")]), true, "the folder around it");
  assert.equal(reservations.overlaps([at("lib_00000001/films/heat.MKV")]), true, "another case");
  assert.equal(reservations.overlaps([at("lib_00000001/Films/Heat 2.mkv")]), false, "a sibling");
  assert.deepEqual(reservations.keys(), ["lib_00000001/Films/Heat.mkv"], "asking holds nothing");
  release();
  assert.equal(reservations.overlaps([at("lib_00000001/Films/Heat.mkv")]), false);
});

test("the queue waits for an item, a move's destination or a re-rooted tree a request holds", () => {
  const reservations = new PathReservations();
  const move = { op: "move", items: [], target: "lib_00000001/Archive" } as unknown as LibraryOp;
  const reroot = { op: "reroot", items: ["Films"], libraryId: "lib_00000001", from: "/media", to: "/elsewhere" } as unknown as LibraryOp;
  const otherReroot = { ...reroot, libraryId: "lib_00000003", from: "/other" } as LibraryOp;
  assert.equal(reservationPause(reservations, move, [at("lib_00000001/Films/Heat.mkv"), at("lib_00000001/Archive/Heat.mkv")]), undefined);
  assert.equal(reservationPause(reservations, reroot, []), undefined);

  const release = reservations.reserve([at("lib_00000002/Heat.mkv")])!;
  assert.equal(reservationPause(reservations, move, [at("lib_00000001/Nested/Heat.mkv")]), "queue", "the item through the parent's key");
  assert.equal(reservationPause(reservations, reroot, []), "queue", "a re-root of the tree that holds it");
  assert.equal(reservationPause(reservations, otherReroot, []), undefined, "another tree");
  release();

  const folder = reservations.reserve([at("lib_00000001/Archive")])!;
  assert.equal(reservationPause(reservations, move, [at("lib_00000001/Other/Ronin.mkv"), at("lib_00000001/Archive/Ronin.mkv")]), "queue", "the destination");
  folder();
  assert.equal(reservationPause(reservations, move, [at("lib_00000001/Films/Heat.mkv"), at("lib_00000001/Archive/Heat.mkv")]), undefined, "released");
});

test("a queued item touches itself, and a move or copy the name it takes in the destination", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "stremio-held-"));
  const other = await mkdtemp(path.join(tmpdir(), "stremio-held-other-"));
  t.after(async () => { await rm(root, { recursive: true, force: true }); await rm(other, { recursive: true, force: true }); });
  await mkdir(path.join(root, "Films"), { recursive: true });
  const record = (id: string, where: string): LibraryRecord => ({ id, name: id, type: "movie", root: where, enabled: true, order: 0, addedAt: "2026-01-01T00:00:00.000Z", writeArtwork: true });
  const one = [record("lib_00000001", root)];
  const two = [record("lib_00000001", root), record("lib_00000002", other)];
  const move = (target: string) => ({ op: "move", items: [], target }) as unknown as LibraryOp;
  const keys = async (libraries: LibraryRecord[], operation: LibraryOp, item: string) => (await queuedItemPaths(libraries, operation, item)).map((held) => held.key);

  assert.equal(destinationOf("Archive", "Films/Heat.mkv"), "Archive/Heat.mkv");
  assert.equal(destinationOf("lib_00000001/Archive", "lib_00000001/Films/"), "lib_00000001/Archive/Films", "a trailing slash names the folder, not the target");
  // Spelled with the platform's own separator, as `resolveLibraryPath` reads an unqualified
  // path: on Windows `Films\Heat.mkv` goes to `Archive/Heat.mkv`.
  assert.equal(destinationOf("Archive", ["Films", "Heat.mkv"].join(path.sep)), "Archive/Heat.mkv");
  assert.deepEqual(await keys(one, { op: "delete", items: [] } as unknown as LibraryOp, "Films/Heat.mkv"), ["lib_00000001/Films/Heat.mkv"], "a delete touches only its item");
  assert.deepEqual(await keys(one, move("Archive"), "Films/Heat.mkv"), ["lib_00000001/Films/Heat.mkv", "lib_00000001/Archive/Heat.mkv"], "an unqualified target in one library");
  assert.deepEqual(await keys(one, move("lib_00000001"), "lib_00000001/Films/Heat.mkv"), ["lib_00000001/Films/Heat.mkv", "lib_00000001/Heat.mkv"], "the library root as target");
  assert.deepEqual(await keys(one, move("lib_00000001/Archive"), "lib_00000001/Films"), ["lib_00000001/Films", "lib_00000001/Archive/Films"], "a folder keeps its own name");
  assert.deepEqual(await keys(two, { op: "copy", items: [], target: "lib_00000002/Kept" } as unknown as LibraryOp, "lib_00000001/Films/Heat.mkv"), ["lib_00000001/Films/Heat.mkv", "lib_00000002/Kept/Heat.mkv"], "a copy into another library");
  assert.deepEqual(await keys(two, {
    op: "rename", items: [], names: { "lib_00000001/Films/Heat.mkv": "Thief.mkv" },
  } as unknown as LibraryOp, "lib_00000001/Films/Heat.mkv"), [
    "lib_00000001/Films/Heat.mkv",
    "lib_00000001/Films/Thief.mkv",
  ], "a rename touches its source and destination");
  assert.deepEqual(await keys(two, move("Archive"), "Films/Heat.mkv"), [], "an unqualified item with two libraries resolves to nothing");
});

test("the queue's busy check reads a folding volume's names as the volume does", () => {
  assert.equal(placesOverlap("/media/Archive/Heat.mkv", "/media/archive", true), true, "a rename of the folder in another case, folding volume");
  assert.equal(placesOverlap("/media/Archive/Heat.mkv", "/media/archive", false), false, "two different folders on a case-sensitive volume");
  assert.equal(placesOverlap("/media/Archive", "/media/Archive/Heat.mkv", false), true, "either way round");
  assert.equal(placesOverlap("/media/Archive 2", "/media/Archive", true), false, "a name that only starts the same");
});

// ---- review/path-reservations-a: proof tests ----

test("a held name is held in its other Unicode normalisation (one file on APFS/HFS+)", () => {
  const reservations = new PathReservations();
  assert.ok(reservations.reserve([{ key: "lib_00000001/Films/Amélie.mkv", absolute: "/media/Films/Amélie.mkv" }]));
  assert.equal(reservations.reserve([{ key: "lib_00000001/Films/Amélie.mkv", absolute: "/media/Films/Amélie.mkv" }]), undefined);
});

test("a held file is held when a library root reaches it through a symlink", async (t) => {
  const work = await mkdtemp(path.join(tmpdir(), "reservations-alias-"));
  t.after(() => rm(work, { recursive: true, force: true }));
  await mkdir(path.join(work, "real", "Films"), { recursive: true });
  await symlink(path.join(work, "real"), path.join(work, "alias"), "dir");
  const libraries = [libraryAt("lib_0000000a", path.join(work, "real")), libraryAt("lib_0000000b", path.join(work, "alias"))];
  const direct = await resolvePlaced(libraries, "lib_0000000a/Films/Heat.mkv");
  const aliased = await resolvePlaced(libraries, "lib_0000000b/Films/Heat.mkv");
  assert.ok(direct && aliased);
  const reservations = new PathReservations();
  assert.ok(reservations.reserve([direct]));
  assert.equal(reservations.overlaps([aliased]), true);
  assert.equal(reservations.reserve([aliased]), undefined);
});

test("a video and the subtitles under its stem hold each other, and nothing else beside them", () => {
  assert.equal(placesOverlap("/media/Films/Heat.mkv", "/media/Films/Heat.en.srt", false), true);
  assert.equal(placesOverlap("/media/Films/heat.EN.SRT", "/media/Films/Heat.mkv", true), true);
  assert.equal(placesOverlap("/media/Films/Heat.mkv", "/media/Films/Heat 2.en.srt", false), false);
  assert.equal(placesOverlap("/media/Films/Heat.mkv", "/media/Films/Heat.nfo", false), false);
  assert.equal(placesOverlap("/media/Films/Heat.mkv", "/media/Archive/Heat.en.srt", false), false);
  assert.equal(placesOverlap("/media/Films/Heat.mkv", "/media/Films/Heat.avi", false), false);
});

test("a held symlink entry still holds the folder it sits in", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "reservations-link-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, "Store", "d"), { recursive: true });
  await mkdir(path.join(root, "Films"));
  await symlink(path.join(root, "Store", "d"), path.join(root, "Films", "Link"), "dir");
  const libraries = [libraryAt("lib_00000001", root)];
  const link = await resolvePlaced(libraries, "lib_00000001/Films/Link");
  const parent = await resolvePlaced(libraries, "lib_00000001/Films");
  assert.ok(link && parent);
  const reservations = new PathReservations();
  assert.ok(reservations.reserve([link]));
  assert.equal(reservations.overlaps([parent]), true, "a rename of the link holds the folder it sits in");
});

test("a held symlinked video still holds its subtitle beside it", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "reservations-link-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, "Store"), { recursive: true });
  await mkdir(path.join(root, "Films"));
  await writeFile(path.join(root, "Store", "abc.mkv"), "v");
  await writeFile(path.join(root, "Films", "Heat.srt"), "s");
  await symlink(path.join(root, "Store", "abc.mkv"), path.join(root, "Films", "Heat.mkv"));
  const libraries = [libraryAt("lib_00000001", root)];
  const video = await resolvePlaced(libraries, "lib_00000001/Films/Heat.mkv");
  const subtitle = await resolvePlaced(libraries, "lib_00000001/Films/Heat.srt");
  assert.ok(video && subtitle);
  const reservations = new PathReservations();
  assert.ok(reservations.reserve([video]));
  assert.equal(reservations.overlaps([subtitle]), true);
});

test("two files reached through one link do not hold each other, but the link holds both", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "reservations-via-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, "Real"), { recursive: true });
  await symlink(path.join(root, "Real"), path.join(root, "Alias"), "dir");
  const libraries = [libraryAt("lib_00000001", root)];
  const heat = await resolvePlaced(libraries, "lib_00000001/Alias/Heat.mkv");
  const thief = await resolvePlaced(libraries, "lib_00000001/Alias/Thief.mkv");
  const link = await resolvePlaced(libraries, "lib_00000001/Alias");
  assert.ok(heat && thief && link);
  const reservations = new PathReservations();
  assert.ok(reservations.reserve([heat]));
  assert.ok(reservations.reserve([thief]), "another file through the same link is free");
  assert.equal(reservations.reserve([link]), undefined, "the link itself is held");
});
