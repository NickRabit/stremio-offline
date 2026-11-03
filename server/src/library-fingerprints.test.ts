import assert from "node:assert/strict";
import { test } from "node:test";
import {
  LibraryFingerprints,
  liftFolders,
  pairMoves,
  type FingerprintRow,
  type FingerprintWalkFile,
} from "./library-fingerprints.js";

const A = "lib_aaaaaaaa";
const B = "lib_bbbbbbbb";
const NOW = Date.parse("2026-03-01T00:00:00.000Z");
const OLD = new Date(NOW - 60 * 60_000).toISOString();

const row = (libraryId: string, relative: string, size: number, mtimeMs: number, hash?: string): FingerprintRow =>
  ({ libraryId, relative, size, mtimeMs, ...(hash ? { hash } : {}) });
const file = (relative: string, size: number, modified = OLD): FingerprintWalkFile => ({ relative, size, modified });
const walk = (libraryId: string, files: FingerprintWalkFile[]) => ({ libraryId, root: "/library", files });

test("a rename with the same size and modification time pairs", () => {
  const result = pairMoves([row(A, "Old/movie.mkv", 10, Date.parse(OLD))], [walk(A, [file("New/movie.mkv", 10)])], { now: NOW });
  assert.deepEqual(result.pairs, [{ libraryId: A, from: "Old/movie.mkv", toLibraryId: A, to: "New/movie.mkv", folder: false }]);
});

test("a copy with a new modification time pairs when both stored hashes match", () => {
  const modified = new Date(NOW - 20 * 60_000).toISOString();
  const result = pairMoves(
    [row(A, "Old/movie.mkv", 10, Date.parse(OLD), "abc123")],
    [walk(A, [file("New/movie.mkv", 10, modified)])],
    { now: NOW, newHashes: new Map([[`${A}/New/movie.mkv`, "abc123"]]) },
  );
  assert.deepEqual(result.pairs.map((pair) => pair.to), ["New/movie.mkv"]);
});

test("equal size with different time and no hash does not pair", () => {
  const modified = new Date(NOW - 20 * 60_000).toISOString();
  const result = pairMoves([row(A, "Old/movie.mkv", 10, Date.parse(OLD))], [walk(A, [file("New/movie.mkv", 10, modified)])], { now: NOW });
  assert.deepEqual(result.pairs, []);
});

test("two candidates on either side stay unpaired", () => {
  const bothA = pairMoves([
    row(A, "Old/movie.mkv", 10, Date.parse(OLD)),
    row(A, "Other/movie.mkv", 10, Date.parse(OLD)),
  ], [walk(A, [file("New/movie.mkv", 10)])], { now: NOW });
  assert.deepEqual(bothA.pairs, []);

  const bothB = pairMoves([row(A, "Old/movie.mkv", 10, Date.parse(OLD))], [walk(A, [
    file("New/movie.mkv", 10),
    file("Other/movie.mkv", 10),
  ])], { now: NOW });
  assert.deepEqual(bothB.pairs, []);
});

test("a file still being written or ending in .part is skipped", () => {
  const writing = new Date(NOW - 9 * 60_000).toISOString();
  const result = pairMoves([
    row(A, "Old/movie.mkv", 10, Date.parse(OLD)),
    row(A, "Old/other.mkv", 20, Date.parse(OLD)),
  ], [walk(A, [
    file("New/movie.mkv", 10, writing),
    file("New/other.mkv.part", 20, writing),
  ])], { now: NOW });
  assert.deepEqual(result.pairs, []);
  assert.deepEqual(result.fresh, []);
});

test("a complete folder move is lifted once at its highest folder", () => {
  const mtime = Date.parse(OLD);
  const result = pairMoves([
    row(A, "Show/S1/e1.mkv", 10, mtime),
    row(A, "Show/S1/e2.mkv", 11, mtime),
  ], [walk(A, [
    file("Show 2/S1/e1.mkv", 10),
    file("Show 2/S1/e2.mkv", 11),
  ])], { now: NOW });
  assert.deepEqual(liftFolders(result.pairs, result.vanished), [{
    libraryId: A, from: "Show", toLibraryId: A, to: "Show 2", folder: true,
  }]);
});

test("a partial folder move stays file by file", () => {
  const mtime = Date.parse(OLD);
  const result = pairMoves([
    row(A, "Show/S1/e1.mkv", 10, mtime),
    row(A, "Show/S1/e2.mkv", 11, mtime),
  ], [walk(A, [file("Show 2/S1/e1.mkv", 10)])], { now: NOW });
  assert.deepEqual(liftFolders(result.pairs, result.vanished), [{
    libraryId: A, from: "Show/S1/e1.mkv", toLibraryId: A, to: "Show 2/S1/e1.mkv", folder: false,
  }]);
});

test("a move between libraries pairs across the instance", () => {
  const result = pairMoves([row(A, "Films/Heat.mkv", 10, Date.parse(OLD))], [
    walk(A, []),
    walk(B, [file("Archive/Heat.mkv", 10)]),
  ], { now: NOW });
  assert.deepEqual(result.pairs, [{
    libraryId: A, from: "Films/Heat.mkv", toLibraryId: B, to: "Archive/Heat.mkv", folder: false,
  }]);
});

test("without a database reconciliation and hashing are no-ops", async () => {
  const store = new LibraryFingerprints();
  await store.load();
  assert.deepEqual(await store.reconcile([walk(A, [file("New/movie.mkv", 10)])]), []);
  assert.equal(await store.hashPending(new Map([[A, "/library"]]), () => false), 0);
});
