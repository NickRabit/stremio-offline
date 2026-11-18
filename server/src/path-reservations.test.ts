import assert from "node:assert/strict";
import { test } from "node:test";
import { PathReservations, reservationPause } from "./path-reservations.js";
import type { LibraryOp } from "./library-ops.js";

test("a held key refuses itself, anything inside it and anything around it until released", () => {
  const reservations = new PathReservations();
  const release = reservations.reserve(["lib_00000001/Films/Heat.mkv", "lib_00000001/Films/Thief.mkv"]);
  assert.ok(release);
  assert.deepEqual(reservations.keys(), ["lib_00000001/Films/Heat.mkv", "lib_00000001/Films/Thief.mkv"]);

  assert.equal(reservations.reserve(["lib_00000001/Films/Thief.mkv", "lib_00000001/Films/Ronin.mkv"]), undefined, "the same name");
  assert.equal(reservations.reserve(["lib_00000001/Films"]), undefined, "the folder around it");
  assert.equal(reservations.reserve(["lib_00000001/films/HEAT.mkv"]), undefined, "another case of the same name");
  assert.deepEqual(reservations.keys(), ["lib_00000001/Films/Heat.mkv", "lib_00000001/Films/Thief.mkv"], "a refused request holds nothing");

  const sibling = reservations.reserve(["lib_00000001/Films/Heat 2.mkv"]);
  assert.ok(sibling, "a sibling whose name only starts the same is free");
  sibling();

  release();
  assert.deepEqual(reservations.keys(), []);
  assert.ok(reservations.reserve(["lib_00000001/Films/Thief.mkv"]));
});

test("overlaps answers for a held key, its folder and another case, without holding anything", () => {
  const reservations = new PathReservations();
  assert.equal(reservations.overlaps(["lib_00000001/Films/Heat.mkv"]), false);
  const release = reservations.reserve(["lib_00000001/Films/Heat.mkv"])!;
  assert.equal(reservations.overlaps(["lib_00000001/Films/Heat.mkv"]), true);
  assert.equal(reservations.overlaps(["lib_00000001/Films"]), true, "the folder around it");
  assert.equal(reservations.overlaps(["lib_00000001/films/heat.MKV"]), true, "another case");
  assert.equal(reservations.overlaps(["lib_00000001/Films/Heat 2.mkv"]), false, "a sibling");
  assert.deepEqual(reservations.keys(), ["lib_00000001/Films/Heat.mkv"], "asking holds nothing");
  release();
  assert.equal(reservations.overlaps(["lib_00000001/Films/Heat.mkv"]), false);
});

test("the queue waits for an item, a move's destination or a re-rooted library a request holds", () => {
  const reservations = new PathReservations();
  const move = { op: "move", items: ["lib_00000001/Films/Heat.mkv"], target: "lib_00000001/Archive" } as unknown as LibraryOp;
  const reroot = { op: "reroot", items: ["Films"], libraryId: "lib_00000001", from: "/a", to: "/b" } as unknown as LibraryOp;
  const otherReroot = { ...reroot, libraryId: "lib_00000002" } as LibraryOp;
  assert.equal(reservationPause(reservations, move, ["lib_00000001/Films/Heat.mkv", "lib_00000001/Archive"]), undefined);
  assert.equal(reservationPause(reservations, reroot, []), undefined);

  const release = reservations.reserve(["lib_00000001/Films/Heat.mkv"])!;
  assert.equal(reservationPause(reservations, move, ["lib_00000001/Films/Heat.mkv"]), "queue", "the item");
  assert.equal(reservationPause(reservations, reroot, []), "queue", "a re-root of the library");
  assert.equal(reservationPause(reservations, otherReroot, []), undefined, "another library");
  release();

  const folder = reservations.reserve(["lib_00000001/Archive"])!;
  assert.equal(reservationPause(reservations, move, ["lib_00000001/Other/Ronin.mkv", "lib_00000001/Archive"]), "queue", "the destination");
  folder();
  assert.equal(reservationPause(reservations, move, ["lib_00000001/Films/Heat.mkv", "lib_00000001/Archive"]), undefined, "released");
});
