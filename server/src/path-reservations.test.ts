import assert from "node:assert/strict";
import { test } from "node:test";
import { PathReservations } from "./path-reservations.js";

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
